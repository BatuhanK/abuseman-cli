/** Bundle the CLI into dist/ (template is shipped alongside). */
import { join } from "node:path";
import { rmSync } from "node:fs";

const root = join(import.meta.dir, "..");
rmSync(join(root, "dist"), { recursive: true, force: true });
const r = await Bun.build({
  entrypoints: [join(root, "src/cli.ts"), join(root, "src/create-bin.ts")],
  outdir: join(root, "dist"),
  target: "bun",
  format: "esm",
  external: ["fflate"],
});
if (!r.success) {
  for (const l of r.logs) console.error(l);
  process.exit(1);
}
console.log(`abx: ${r.outputs.map((o) => o.path).join(", ")}`);
