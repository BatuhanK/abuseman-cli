/**
 * Build the publishable `abx` package:
 * - `dist/cli.js`, `dist/create-bin.js`, `dist/index.js`: self-contained bundles (target bun;
 *   `@abuseman/schemas`, zod and fflate are bundled in, so the package has no runtime dependencies);
 * - `sdk/*.tgz` + `sdk/sdk.json`: standalone SDK packages for `abx create --sdk local`.
 * `bin/*.js` run `src/` in a repo checkout and `dist/` in an installed package (no `src/` shipped).
 */
import { join } from "node:path";
import { rmSync } from "node:fs";
import { packSdk } from "../src/lib/sdk";

const root = join(import.meta.dir, "..");
rmSync(join(root, "dist"), { recursive: true, force: true });
const r = await Bun.build({
  entrypoints: [join(root, "src/cli.ts"), join(root, "src/create-bin.ts"), join(root, "src/index.ts")],
  outdir: join(root, "dist"),
  target: "bun",
  format: "esm",
});
if (!r.success) {
  for (const l of r.logs) console.error(l);
  process.exit(1);
}
console.log(`abx: ${r.outputs.map((o) => o.path).join(", ")}`);

const sdk = packSdk(join(root, ".."), join(root, "sdk"));
console.log(`abx: sdk ${sdk.version}: ${Object.values(sdk.packages).join(", ")}`);
