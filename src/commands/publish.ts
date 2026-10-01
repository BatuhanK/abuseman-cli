import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { unzipSync } from "fflate";
import { ApiError, DevUploadResponse, Manifest } from "@abuseman/schemas";
import { color, type IO } from "../lib/io";
import { CliError } from "../lib/manifest";
import { packTo } from "./pack";

export const DEFAULT_API_URL = "https://abuseman.abuse.ltd";

/** Developer API token: `--token`, `$ABX_TOKEN`, or `~/.config/abx/token`. */
export function resolveToken(flag?: string): string {
  if (flag) return flag.trim();
  if (process.env.ABX_TOKEN) return process.env.ABX_TOKEN.trim();
  const file = join(process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"), "abx/token");
  if (existsSync(file)) {
    const t = readFileSync(file, "utf8").trim();
    if (t) return t;
  }
  throw new CliError("no developer token: pass --token, set ABX_TOKEN or write it to ~/.config/abx/token (create one in Dashboard → Developer)");
}

export async function publish(argv: string[], io: IO): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      token: { type: "string" },
      file: { type: "string" },
      api: { type: "string" },
    },
  });
  const token = resolveToken(values.token);
  const api = (values.api ?? process.env.ABX_API_URL ?? DEFAULT_API_URL).replace(/\/+$/, "");
  let file = values.file ? resolve(values.file) : undefined;
  let tmp: string | undefined;
  try {
    if (!file) {
      tmp = mkdtempSync(join(tmpdir(), "abx-publish-"));
      const dir = resolve(positionals[0] ?? ".");
      file = await packTo(dir, { out: join(tmp, "package.amx") }, io);
    }
    const bytes = readFileSync(file);
    const manifestBytes = unzipSync(new Uint8Array(bytes), { filter: (f) => f.name === "manifest.json" })["manifest.json"];
    if (!manifestBytes) throw new CliError(`${file} has no manifest.json`);
    const manifest = Manifest.parse(JSON.parse(new TextDecoder().decode(manifestBytes)));
    const url = `${api}/api/dev/extensions/${encodeURIComponent(manifest.id)}/versions`;
    const form = new FormData();
    form.append("file", new File([bytes], basename(file).endsWith(".amx") ? basename(file) : `${manifest.id}-${manifest.version}.amx`, { type: "application/zip" }));
    io.err(`uploading ${manifest.id}@${manifest.version} (${(bytes.length / 1024).toFixed(1)} KiB) to ${url}`);
    const res = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${token}` }, body: form });
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = undefined;
    }
    if (!res.ok) {
      const e = ApiError.safeParse(body);
      throw new CliError(`upload failed (HTTP ${res.status}): ${e.success ? `${e.data.error}: ${e.data.message}` : text.slice(0, 500)}`);
    }
    const r = DevUploadResponse.safeParse(body);
    if (!r.success) throw new CliError(`unexpected response: ${text.slice(0, 500)}`);
    io.out(`${color.green("✓")} submitted ${manifest.id}@${manifest.version} — version ${r.data.versionId} is ${r.data.status} review`);
    return 0;
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  }
}
