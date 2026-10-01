import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { packExtension } from "../lib/amx";
import { buildExtension } from "../lib/build";
import { keyIdFromPath, loadPrivateKey } from "../lib/crypto";
import type { IO } from "../lib/io";
import { lintExtension } from "../lib/lint";
import { CliError, readManifest } from "../lib/manifest";

export async function pack(argv: string[], io: IO): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      sign: { type: "string" },
      "key-id": { type: "string" },
      out: { type: "string", short: "o" },
      "no-build": { type: "boolean", default: false },
    },
  });
  const dir = resolve(positionals[0] ?? ".");
  const out = await packTo(dir, {
    ...(values.sign ? { sign: values.sign } : {}),
    ...(values["key-id"] ? { keyId: values["key-id"] } : {}),
    ...(values.out ? { out: values.out } : {}),
    build: !values["no-build"],
  }, io);
  io.out(out);
  return 0;
}

/** Build (optional), lint (errors abort), pack. Returns the written path. */
export async function packTo(
  dir: string,
  opts: { sign?: string; keyId?: string; out?: string; build?: boolean },
  io: IO,
): Promise<string> {
  if (opts.build !== false) await buildExtension(dir);
  const { issues } = lintExtension(dir);
  const errors = issues.filter((i) => i.level === "error");
  if (errors.length) throw new CliError(`lint failed:\n${errors.map((e) => `  - ${e.message}`).join("\n")}`);
  const manifest = readManifest(dir);
  const sign = opts.sign ? { key: loadPrivateKey(opts.sign), keyId: opts.keyId ?? keyIdFromPath(opts.sign) } : undefined;
  const r = packExtension(dir, manifest, sign);
  const outPath = resolve(opts.out ?? join(process.cwd(), `${manifest.id}-${manifest.version}.amx`));
  writeFileSync(outPath, r.bytes);
  io.err(`packed ${r.files.length} files (${(r.bytes.length / 1024).toFixed(1)} KiB)${r.signed ? `, signed with ${r.keyId}` : ", unsigned"}`);
  return outPath;
}
