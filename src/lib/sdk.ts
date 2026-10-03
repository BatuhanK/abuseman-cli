/**
 * Local SDK tarballs for `abx create --sdk local` (the default while `@abuseman/api`, `@abuseman/ui`
 * and `@abuseman/schemas` are not published).
 *
 * `abx` ships `sdk/*.tgz` + `sdk/sdk.json` (written by `scripts/build.ts`). Inside a repo checkout
 * the tarballs are packed fresh from `packages/*` instead, so they always match the sources.
 * Each tarball holds the package's TypeScript sources (types for `tsc` and editors resolve to
 * `src/index.ts`); `@abuseman/*` cross-dependencies are removed and the new project depends on
 * all three tarballs directly, so `bun install` needs nothing unpublished.
 */
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliError } from "./manifest";

/** Monorepo folder (under `packages/`) of each SDK package. Order matters for nothing. */
export const SDK_PACKAGES = [
  { name: "@abuseman/schemas", dir: "schemas" },
  { name: "@abuseman/api", dir: "extension-api" },
  { name: "@abuseman/ui", dir: "extension-ui" },
] as const;

export type SdkName = (typeof SDK_PACKAGES)[number]["name"];

/** `sdk/sdk.json`: package name → tarball file name (next to it). */
export interface SdkIndex {
  version: string;
  packages: Record<SdkName, string>;
}

/**
 * npm name of this CLI (`abx` is taken on npm). The workspace package and the bins are `abx`;
 * `scripts/build.ts` stages the published package under this name.
 */
export const CLI_PACKAGE_NAME = "abuseman-cli";

/** Root of the `abx` package (`<root>/package.json`), from `src/lib/` and from the bundled `dist/`. */
export const ABX_ROOT =
  [join(import.meta.dir, "../.."), join(import.meta.dir, "..")].find((p) => {
    try {
      const name = (JSON.parse(readFileSync(join(p, "package.json"), "utf8")) as { name?: string }).name;
      return name === "abx" || name === CLI_PACKAGE_NAME;
    } catch {
      return false;
    }
  }) ?? join(import.meta.dir, "../..");

/** `packages/` of the monorepo when `abx` runs from a checkout, otherwise `undefined`. */
export function monorepoPackagesDir(): string | undefined {
  const dir = join(ABX_ROOT, "..");
  return SDK_PACKAGES.every((p) => existsSync(join(dir, p.dir, "package.json")) && existsSync(join(dir, p.dir, "src"))) ? dir : undefined;
}

type Exports = Record<string, string | Record<string, string>>;

/** package.json of the standalone SDK package: sources only, no workspace references. */
function standalonePackageJson(pkg: Record<string, any>): Record<string, unknown> {
  const exports: Record<string, { types: string; default: string }> = {};
  for (const [key, value] of Object.entries((pkg.exports ?? {}) as Exports)) {
    if (typeof value !== "object" || !value.types) continue; // json/*, fixtures/*: not needed by extensions
    exports[key] = { types: value.types, default: value.bun ?? value.types };
  }
  const deps: Record<string, string> = {};
  for (const [name, range] of Object.entries((pkg.dependencies ?? {}) as Record<string, string>)) {
    if (name.startsWith("@abuseman/")) continue; // the project depends on every SDK tarball directly
    deps[name] = range;
    // Types of runtime deps (e.g. react-reconciler) must be installed for tsc to read the sources.
    const types = `@types/${name.replace(/^@([^/]+)\//, "$1__")}`;
    const typesRange = pkg.devDependencies?.[types];
    if (typesRange) deps[types] = typesRange;
  }
  return {
    name: pkg.name,
    version: pkg.version,
    description: pkg.description,
    type: "module",
    license: pkg.license,
    exports,
    files: ["src"],
    ...(Object.keys(deps).length ? { dependencies: deps } : {}),
    ...(pkg.peerDependencies ? { peerDependencies: pkg.peerDependencies } : {}),
  };
}

/** Pack the SDK packages of the monorepo at `packagesDir` into `outDir` (+ `sdk.json`). */
export function packSdk(packagesDir: string, outDir: string): SdkIndex {
  mkdirSync(outDir, { recursive: true });
  for (const f of readdirSync(outDir)) if (f.endsWith(".tgz") || f === "sdk.json") rmSync(join(outDir, f));
  const index: SdkIndex = { version: "", packages: {} as Record<SdkName, string> };
  for (const { name, dir } of SDK_PACKAGES) {
    const from = join(packagesDir, dir);
    const pkg = JSON.parse(readFileSync(join(from, "package.json"), "utf8")) as Record<string, any>;
    index.version ||= pkg.version;
    const stage = mkdtempSync(join(tmpdir(), "abx-sdk-"));
    try {
      cpSync(join(from, "src"), join(stage, "src"), { recursive: true });
      writeFileSync(join(stage, "package.json"), `${JSON.stringify(standalonePackageJson(pkg), null, 2)}\n`);
      const before = new Set(readdirSync(outDir));
      const r = Bun.spawnSync([process.execPath, "pm", "pack", "--quiet", "--destination", outDir], { cwd: stage, stderr: "pipe", stdout: "pipe" });
      const tgz = readdirSync(outDir).find((f) => f.endsWith(".tgz") && !before.has(f));
      if (r.exitCode !== 0 || !tgz) throw new CliError(`could not pack ${name}: ${r.stderr.toString() || r.stdout.toString()}`);
      index.packages[name] = tgz;
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  }
  writeFileSync(join(outDir, "sdk.json"), `${JSON.stringify(index, null, 2)}\n`);
  return index;
}

/**
 * Put the SDK tarballs (+ `sdk.json`) into `destDir`: packed from the sources in a repo checkout,
 * copied from the bundled `sdk/` otherwise. Returns the index (package name → tarball file).
 */
export function vendorSdk(destDir: string): SdkIndex {
  const repo = monorepoPackagesDir();
  if (repo) return packSdk(repo, destDir); // checkout: always current sources
  const bundled = join(ABX_ROOT, "sdk");
  if (!existsSync(join(bundled, "sdk.json"))) {
    throw new CliError(`this abx has no bundled SDK (${bundled}); reinstall ${CLI_PACKAGE_NAME} or use --sdk npm`);
  }
  const index = JSON.parse(readFileSync(join(bundled, "sdk.json"), "utf8")) as SdkIndex;
  mkdirSync(destDir, { recursive: true });
  for (const tgz of Object.values(index.packages)) copyFileSync(join(bundled, tgz), join(destDir, tgz));
  writeFileSync(join(destDir, "sdk.json"), `${JSON.stringify(index, null, 2)}\n`);
  return index;
}
