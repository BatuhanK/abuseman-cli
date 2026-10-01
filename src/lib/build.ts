import { dirname, join, basename } from "node:path";
import { HOST_PROVIDED_MODULES, type Manifest } from "@abuseman/schemas";
import { CliError, findEntry, readManifest } from "./manifest";

export interface BuildOptions {
  /** Development build: no minification, inline source map. */
  dev?: boolean;
  /** Minify (default: true for production builds). */
  minify?: boolean;
}

export interface BuildResult {
  manifest: Manifest;
  outfile: string;
  bytes: number;
  durationMs: number;
}

/**
 * Bundle `src/index.ts(x)` → `<manifest.main>` (ESM, target bun).
 *
 * Host-provided modules (`@abuseman/api`, `@abuseman/ui`, `react`, `react/jsx-runtime`,
 * `react/jsx-dev-runtime`, `zod`, `zod/v4`) are kept EXTERNAL: the extension host serves its own
 * copies as virtual modules at runtime, so there is exactly one React (shared with the
 * reconciler) and one UI runtime. Everything else (npm deps) is bundled.
 */
export async function buildExtension(dir: string, opts: BuildOptions = {}): Promise<BuildResult> {
  const started = performance.now();
  const manifest = readManifest(dir);
  const entry = findEntry(dir);
  const outfile = join(dir, manifest.main);
  const result = await Bun.build({
    entrypoints: [entry],
    outdir: dirname(outfile),
    naming: basename(outfile),
    target: "bun",
    format: "esm",
    external: [...HOST_PROVIDED_MODULES],
    minify: opts.minify ?? !opts.dev,
    sourcemap: opts.dev ? "inline" : "linked",
    // Production JSX (`jsx` from react/jsx-runtime): the host ships production React.
    define: { "process.env.NODE_ENV": JSON.stringify(opts.dev ? "development" : "production") },
    jsx: { runtime: "automatic", importSource: "react", development: false },
    throw: false,
  } as Parameters<typeof Bun.build>[0]);
  if (!result.success) {
    const msg = result.logs.map((l) => String(l)).join("\n");
    throw new CliError(`build failed:\n${msg}`);
  }
  const out = result.outputs.find((o) => o.kind === "entry-point")!;
  return { manifest, outfile, bytes: out.size, durationMs: Math.round(performance.now() - started) };
}
