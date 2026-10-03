/**
 * Build the publishable `abx` package:
 * - `dist/cli.js`, `dist/create-bin.js`, `dist/index.js`: self-contained bundles (target bun;
 *   `@abuseman/schemas`, zod and fflate are bundled in, so the package has no runtime dependencies);
 * - `sdk/*.tgz` + `sdk/sdk.json`: standalone SDK packages for `abx create --sdk local`;
 * - `.pack/abuseman-cli/`: the npm package (`abx` is taken on npm): bin, dist, template, sdk, README
 *   and LICENSE, with a manifest that has no workspace references and exports only `dist/`;
 * - `.pack/create-abuseman-extension/`: `bun create abuseman-extension <dir>`, which runs `abx create`
 *   from the `abuseman-cli` of the same version.
 * `bin/*.js` run `src/` in a repo checkout and `dist/` in an installed package (no `src/` shipped).
 * `make abx-install` installs `.pack/abuseman-cli`; `make abx-publish` publishes both packages.
 */
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CLI_PACKAGE_NAME, packSdk } from "../src/lib/sdk";

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

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { version: string; description: string; license: string };
const shared = {
  version: pkg.version,
  license: pkg.license,
  author: "Batuhan KATIRCI",
  homepage: "https://abuseman.abuse.ltd/docs/extension-sdk",
  repository: { type: "git", url: "git+https://github.com/BatuhanK/abuseman-cli.git" },
  bugs: { url: "https://github.com/BatuhanK/abuseman-cli/issues" },
  keywords: ["abuseman", "extension", "cli", "http", "proxy", "debugging"],
  type: "module",
  engines: { bun: ">=1.4.0" },
};
const writeJson = (path: string, value: unknown) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
const pack = join(root, ".pack");
rmSync(pack, { recursive: true, force: true });

const cli = join(pack, CLI_PACKAGE_NAME);
mkdirSync(join(cli, "bin"), { recursive: true });
cpSync(join(root, "bin/abx.js"), join(cli, "bin/abx.js"));
for (const f of ["dist", "template", "sdk", "README.md", "LICENSE"]) cpSync(join(root, f), join(cli, f), { recursive: true });
writeJson(join(cli, "package.json"), {
  name: CLI_PACKAGE_NAME,
  description: pkg.description,
  ...shared,
  bin: { abx: "./bin/abx.js", [CLI_PACKAGE_NAME]: "./bin/abx.js" },
  exports: { ".": "./dist/index.js" },
  files: ["bin", "dist", "template", "sdk"],
});

const create = join(pack, "create-abuseman-extension");
mkdirSync(create, { recursive: true });
cpSync(join(root, "LICENSE"), join(create, "LICENSE"));
writeFileSync(
  join(create, "index.js"),
  `#!/usr/bin/env bun\n// \`bun create abuseman-extension <dir>\`: \`abx create\` from ${CLI_PACKAGE_NAME}.\nimport { run } from "${CLI_PACKAGE_NAME}";\n\nprocess.exit(await run(["create", ...process.argv.slice(2)]));\n`,
  { mode: 0o755 },
);
writeFileSync(
  join(create, "README.md"),
  `# create-abuseman-extension\n\nScaffold an [AbuseMan](https://abuseman.abuse.ltd) extension:\n\n\`\`\`sh\nbun create abuseman-extension my-extension\ncd my-extension\nbun install\nbun run dev\n\`\`\`\n\nIt runs \`abx create\` from [${CLI_PACKAGE_NAME}](https://www.npmjs.com/package/${CLI_PACKAGE_NAME}) (options: \`--id\`, \`--name\`). Requires [Bun](https://bun.sh) 1.4+.\n`,
);
writeJson(join(create, "package.json"), {
  name: "create-abuseman-extension",
  description: "Create an AbuseMan extension: bun create abuseman-extension <dir>",
  ...shared,
  bin: { "create-abuseman-extension": "./index.js" },
  files: ["index.js"],
  dependencies: { [CLI_PACKAGE_NAME]: pkg.version },
});
console.log(`abx: staged ${CLI_PACKAGE_NAME}@${pkg.version} and create-abuseman-extension@${pkg.version} in .pack/`);
