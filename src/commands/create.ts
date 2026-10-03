import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { EXTENSION_ID_RE } from "@abuseman/schemas";
import type { IO } from "../lib/io";
import { CliError } from "../lib/manifest";
import { vendorSdk } from "../lib/sdk";
import pkg from "../../package.json" with { type: "json" };

/** Template folder: `<pkg>/template` (works from `src/commands/` and from the bundled `dist/`). */
export const TEMPLATE_DIR =
  [join(import.meta.dir, "../../template"), join(import.meta.dir, "../template")].find((p) => existsSync(join(p, "manifest.json"))) ??
  join(import.meta.dir, "../../template");

/**
 * Template files stored under another name: npm-style packing drops or renames `.gitignore`, and an
 * AGENTS.md / CLAUDE.md here would be read by coding agents working in the AbuseMan repo itself.
 */
const RENAME: Record<string, string> = {
  gitignore: ".gitignore",
  "AGENTS.template.md": "AGENTS.md",
  "CLAUDE.template.md": "CLAUDE.md",
};

/** Where `--sdk local` puts the SDK tarballs inside the new project. */
export const LOCAL_SDK_DIR = ".abuseman/sdk";

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "extension";
}

/**
 * `--sdk npm`: the template's registry versions (once `@abuseman/*` are published).
 * `--sdk local` (default while unpublished): vendor the SDK tarballs into `.abuseman/sdk/` and depend
 * on them with `file:` specifiers. Either way the CLI itself (`abuseman-cli`, bins `abx`) comes from npm.
 */
function useLocalSdk(dir: string): string[] {
  const index = vendorSdk(join(dir, LOCAL_SDK_DIR));
  const pkgPath = join(dir, "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as Record<string, any>;
  const deps: Record<string, string> = {};
  for (const [name, tgz] of Object.entries(index.packages)) deps[name] = `file:./${LOCAL_SDK_DIR}/${tgz}`;
  pkg.dependencies = deps;
  writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
  return Object.values(index.packages).map((f) => `${LOCAL_SDK_DIR}/${f}`);
}

export async function create(argv: string[], io: IO): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      id: { type: "string" },
      name: { type: "string" },
      author: { type: "string" },
      sdk: { type: "string", default: "local" },
      force: { type: "boolean", default: false },
    },
  });
  const target = positionals[0];
  if (!target) throw new CliError('usage: abx create <dir> [--id com.example.my-ext] [--name "My Extension"] [--sdk local|npm]', 2);
  if (values.sdk !== "local" && values.sdk !== "npm") throw new CliError(`--sdk must be "local" or "npm" (got "${values.sdk}")`, 2);
  const dir = resolve(target);
  if (existsSync(dir) && readdirSync(dir).length > 0 && !values.force) throw new CliError(`${dir} exists and is not empty (use --force)`);
  const base = slug(basename(dir));
  const id = values.id ?? `com.example.${base}`;
  if (!EXTENSION_ID_RE.test(id)) throw new CliError(`invalid extension id "${id}" (reverse-DNS, [a-z0-9.-])`);
  const name = values.name ?? basename(dir).replace(/[-_]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const prefix = id.split(".").pop()!.replace(/-/g, "_");
  const vars: Record<string, string> = {
    __ID__: id,
    __NAME__: name,
    __AUTHOR__: values.author ?? process.env.USER ?? "Me",
    __PREFIX__: prefix,
    __PKG__: base,
    __ABX_VERSION__: pkg.version,
  };
  const written: string[] = [];
  const copy = (from: string, to: string) => {
    for (const entry of readdirSync(from).sort()) {
      const src = join(from, entry);
      const dst = join(to, RENAME[entry] ?? entry);
      if (statSync(src).isDirectory()) {
        mkdirSync(dst, { recursive: true });
        copy(src, dst);
      } else {
        let text = readFileSync(src, "utf8");
        for (const [k, v] of Object.entries(vars)) text = text.split(k).join(k === "__NAME__" && src.endsWith(".json") ? v.replace(/"/g, '\\"') : v);
        writeFileSync(dst, text);
        written.push(relative(dir, dst));
      }
    }
  };
  mkdirSync(dir, { recursive: true });
  copy(TEMPLATE_DIR, dir);
  if (values.sdk === "local") written.push(...useLocalSdk(dir));
  io.out(`Created ${name} (${id}) in ${dir}`);
  for (const f of written.sort()) io.out(`  ${f}`);
  io.out("");
  io.out(values.sdk === "local" ? `SDK: local tarballs in ${LOCAL_SDK_DIR}/ (--sdk npm uses registry versions once they are published)` : "SDK: npm registry versions");
  io.out("");
  io.out("Next steps:");
  io.out(`  cd ${relative(process.cwd(), dir) || "."}`);
  io.out("  bun install");
  io.out("  bun run dev     # build, load into AbuseMan and hot-reload on every change");
  io.out("");
  io.out("`bun run dev` needs AbuseMan running with Settings › Extensions › Developer mode turned on.");
  io.out("Coding agents: see AGENTS.md in the new project.");
  return 0;
}
