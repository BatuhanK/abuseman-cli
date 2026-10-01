import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { buildExtension } from "../lib/build";
import type { IO } from "../lib/io";

export async function build(argv: string[], io: IO): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { dev: { type: "boolean", default: false }, "no-minify": { type: "boolean", default: false } },
  });
  const dir = resolve(positionals[0] ?? ".");
  const r = await buildExtension(dir, { dev: values.dev, ...(values["no-minify"] ? { minify: false } : {}) });
  io.out(`built ${r.manifest.id}@${r.manifest.version} → ${r.outfile} (${(r.bytes / 1024).toFixed(1)} KiB, ${r.durationMs} ms)`);
  return 0;
}
