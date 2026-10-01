import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import { EXTENSION_ID_RE } from "@abuseman/schemas";
import type { IO } from "../lib/io";
import { CliError } from "../lib/manifest";

/** Template folder: `<pkg>/template` (works from `src/commands/` and from the bundled `dist/`). */
export const TEMPLATE_DIR =
  [join(import.meta.dir, "../../template"), join(import.meta.dir, "../template")].find((p) => existsSync(join(p, "manifest.json"))) ??
  join(import.meta.dir, "../../template");

const RENAME: Record<string, string> = { gitignore: ".gitignore" };

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "extension";
}

export async function create(argv: string[], io: IO): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      id: { type: "string" },
      name: { type: "string" },
      author: { type: "string" },
      force: { type: "boolean", default: false },
    },
  });
  const target = positionals[0];
  if (!target) throw new CliError("usage: abx create <dir> [--id com.example.my-ext] [--name \"My Extension\"]", 2);
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
  io.out(`Created ${name} (${id}) in ${dir}`);
  for (const f of written) io.out(`  ${f}`);
  io.out("");
  io.out("Next steps:");
  io.out(`  cd ${relative(process.cwd(), dir) || "."}`);
  io.out("  bun install");
  io.out("  bun run dev     # build, load into AbuseMan and hot-reload");
  return 0;
}
