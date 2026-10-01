/**
 * `.amx` packaging (CONTRACTS §7): deterministic zip with `META-INF/files.json` and optional
 * `META-INF/signature.json` = ed25519( sha256( canonicalJSON(files.json) ) ), base64.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { unzipSync, zipSync, type Zippable } from "fflate";
import type { KeyObject } from "node:crypto";
import {
  AMX_FILES_JSON,
  AMX_META_PREFIX,
  AMX_SIGNATURE_JSON,
  AmxFilesJson,
  AmxSignatureJson,
  Manifest,
  canonicalJson,
  type AmxFileEntry,
  type Manifest as ManifestT,
} from "@abuseman/schemas";
import { ed25519Sign, ed25519Verify, sha256, sha256Hex } from "./crypto";
import { CliError } from "./manifest";

/** Fixed timestamp for every zip entry (local-time DOS fields → identical bytes in any TZ). */
const ZIP_MTIME = new Date(1980, 0, 1, 0, 0, 0);
const MAX_PACKAGE_BYTES = 64 * 1024 * 1024;

const toPosix = (p: string) => p.split(sep).join("/");

function walk(dir: string, root: string, out: string[]) {
  if (!existsSync(dir)) return;
  for (const name of readdirSync(dir).sort()) {
    if (name === ".DS_Store") continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, root, out);
    else if (st.isFile()) out.push(toPosix(relative(root, full)));
  }
}

/** Files that go into the package (relative POSIX paths, sorted). */
export function collectPackageFiles(dir: string, manifest: ManifestT): string[] {
  const files = new Set<string>(["manifest.json"]);
  const main = toPosix(manifest.main);
  if (!existsSync(join(dir, main))) throw new CliError(`main "${main}" does not exist — run \`abx build\` first`);
  files.add(main);
  const distFiles: string[] = [];
  walk(join(dir, "dist"), dir, distFiles);
  distFiles.forEach((f) => files.add(f));
  if (manifest.icon && !manifest.icon.startsWith("sf:") && !/^https?:/.test(manifest.icon)) {
    if (!existsSync(join(dir, manifest.icon))) throw new CliError(`icon "${manifest.icon}" does not exist`);
    files.add(toPosix(manifest.icon));
  }
  for (const optional of ["icon.png", "README.md", "CHANGELOG.md", "LICENSE"]) {
    if (existsSync(join(dir, optional))) files.add(optional);
  }
  const assets: string[] = [];
  walk(join(dir, "assets"), dir, assets);
  assets.forEach((f) => files.add(f));
  for (const f of files) {
    if (f.startsWith(AMX_META_PREFIX)) throw new CliError(`refusing to package reserved path ${f}`);
  }
  return [...files].sort();
}

export interface PackResult {
  bytes: Uint8Array;
  files: AmxFileEntry[];
  signed: boolean;
  keyId?: string;
}

/** Sign `files.json`: returns the `signature.json` object. */
export function signFiles(files: AmxFileEntry[], key: KeyObject, keyId: string) {
  const digest = sha256(canonicalJson(files));
  return { alg: "ed25519" as const, keyId, sig: Buffer.from(ed25519Sign(digest, key)).toString("base64") };
}

/** Build a deterministic `.amx` from an extension folder (already built). */
export function packExtension(dir: string, manifest: ManifestT, sign?: { key: KeyObject; keyId: string }): PackResult {
  const paths = collectPackageFiles(dir, manifest);
  const contents = new Map(paths.map((p) => [p, new Uint8Array(readFileSync(join(dir, p)))] as const));
  const files: AmxFileEntry[] = paths.map((p) => ({ path: p, sha256: sha256Hex(contents.get(p)!) }));
  const zip: Zippable = {};
  for (const p of paths) zip[p] = [contents.get(p)!, { mtime: ZIP_MTIME, level: 9 }];
  zip[AMX_FILES_JSON] = [new TextEncoder().encode(`${JSON.stringify(files, null, 2)}\n`), { mtime: ZIP_MTIME, level: 9 }];
  if (sign) {
    const sig = signFiles(files, sign.key, sign.keyId);
    zip[AMX_SIGNATURE_JSON] = [new TextEncoder().encode(`${JSON.stringify(sig, null, 2)}\n`), { mtime: ZIP_MTIME, level: 9 }];
  }
  // Insertion order defines entry order: sorted package files, then META-INF.
  const bytes = zipSync(zip);
  if (bytes.length > MAX_PACKAGE_BYTES) throw new CliError(`package is ${bytes.length} bytes (max ${MAX_PACKAGE_BYTES})`);
  return { bytes, files, signed: !!sign, ...(sign ? { keyId: sign.keyId } : {}) };
}

export interface VerifyResult {
  ok: boolean;
  manifest?: ManifestT;
  files: AmxFileEntry[];
  signature?: { keyId: string; valid: boolean };
  errors: string[];
}

/**
 * Verify an `.amx`: entry paths, files.json coverage + hashes, manifest schema and (when
 * `lookupKey` is given) the signature.
 */
export function verifyPackage(
  bytes: Uint8Array,
  opts: { lookupKey?: (keyId: string) => KeyObject | undefined; requireSignature?: boolean } = {},
): VerifyResult {
  const errors: string[] = [];
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch (e) {
    return { ok: false, files: [], errors: [`not a valid zip: ${e instanceof Error ? e.message : String(e)}`] };
  }
  const names = Object.keys(entries).filter((n) => !n.endsWith("/"));
  for (const n of names) {
    if (n.startsWith("/") || n.split("/").includes("..") || n.includes("\\")) errors.push(`unsafe entry path: ${n}`);
  }
  const filesRaw = entries[AMX_FILES_JSON];
  if (!filesRaw) return { ok: false, files: [], errors: [...errors, `missing ${AMX_FILES_JSON}`] };
  let files: AmxFileEntry[] = [];
  try {
    files = AmxFilesJson.parse(JSON.parse(new TextDecoder().decode(filesRaw)));
  } catch (e) {
    errors.push(`invalid ${AMX_FILES_JSON}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const listed = new Set(files.map((f) => f.path));
  for (const f of files) {
    const data = entries[f.path];
    if (!data) errors.push(`listed file missing from archive: ${f.path}`);
    else if (sha256Hex(data) !== f.sha256) errors.push(`hash mismatch: ${f.path}`);
  }
  for (const n of names) {
    if (!n.startsWith(AMX_META_PREFIX) && !listed.has(n)) errors.push(`file not listed in files.json: ${n}`);
  }
  for (const n of names) {
    if (n.startsWith(AMX_META_PREFIX) && n !== AMX_FILES_JSON && n !== AMX_SIGNATURE_JSON) errors.push(`unexpected META-INF entry: ${n}`);
  }
  let manifest: ManifestT | undefined;
  const mRaw = entries["manifest.json"];
  if (!mRaw) errors.push("missing manifest.json");
  else {
    const r = Manifest.safeParse(JSON.parse(new TextDecoder().decode(mRaw)));
    if (!r.success) errors.push(`invalid manifest.json: ${r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    else {
      manifest = r.data;
      if (!entries[manifest.main]) errors.push(`main "${manifest.main}" missing from archive`);
    }
  }
  let signature: VerifyResult["signature"];
  const sigRaw = entries[AMX_SIGNATURE_JSON];
  if (sigRaw) {
    try {
      const sig = AmxSignatureJson.parse(JSON.parse(new TextDecoder().decode(sigRaw)));
      if (opts.lookupKey) {
        const key = opts.lookupKey(sig.keyId);
        if (!key) {
          errors.push(`no public key for keyId "${sig.keyId}"`);
          signature = { keyId: sig.keyId, valid: false };
        } else {
          const valid = ed25519Verify(sha256(canonicalJson(files)), key, Buffer.from(sig.sig, "base64"));
          if (!valid) errors.push(`signature by "${sig.keyId}" is INVALID`);
          signature = { keyId: sig.keyId, valid };
        }
      } else signature = { keyId: sig.keyId, valid: false };
    } catch (e) {
      errors.push(`invalid ${AMX_SIGNATURE_JSON}: ${e instanceof Error ? e.message : String(e)}`);
    }
  } else if (opts.requireSignature) errors.push("package is not signed");
  return { ok: errors.length === 0, ...(manifest ? { manifest } : {}), files, ...(signature ? { signature } : {}), errors };
}
