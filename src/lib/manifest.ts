import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Manifest, type Manifest as ManifestT } from "@abuseman/schemas";

export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = "CliError";
  }
}

/** Read and validate `<dir>/manifest.json`. */
export function readManifest(dir: string): ManifestT {
  const raw = readRawManifest(dir);
  const r = Manifest.safeParse(raw);
  if (!r.success) {
    const issues = r.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`).join("\n");
    throw new CliError(`manifest.json is invalid:\n${issues}`);
  }
  return r.data;
}

export function readRawManifest(dir: string): unknown {
  const path = join(dir, "manifest.json");
  if (!existsSync(path)) throw new CliError(`no manifest.json in ${dir}`);
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new CliError(`manifest.json is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** Source entry point: `src/index.tsx`, `src/index.ts`, `src/main.tsx`, `src/main.ts` (first found). */
export function findEntry(dir: string): string {
  for (const c of ["src/index.tsx", "src/index.ts", "src/main.tsx", "src/main.ts", "src/index.jsx", "src/index.js"]) {
    const p = join(dir, c);
    if (existsSync(p)) return p;
  }
  throw new CliError(`no entry point found (expected src/index.ts or src/index.tsx) in ${dir}`);
}
