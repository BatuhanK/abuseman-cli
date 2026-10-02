import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { color, type IO } from "../lib/io";
import { lintExtension, lintScriptDir } from "../lib/lint";

export async function lint(argv: string[], io: IO): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      strict: { type: "boolean", default: false },
      json: { type: "boolean", default: false },
      // A user script folder ($SUPPORT/Scripts/<slug>) instead of an extension project.
      script: { type: "boolean", default: false },
    },
  });
  const dir = resolve(positionals[0] ?? ".");
  const { issues, manifest } = values.script ? { issues: lintScriptDir(dir), manifest: undefined } : lintExtension(dir);
  const errors = issues.filter((i) => i.level === "error");
  const warnings = issues.filter((i) => i.level === "warning");
  if (values.json) io.out(JSON.stringify({ ok: errors.length === 0, issues }, null, 2));
  else {
    for (const i of issues) {
      const tag = i.level === "error" ? color.red("error") : color.yellow("warning");
      const where = i.file ? ` ${i.file}${i.line ? `:${i.line}:${i.column}` : ""}` : "";
      io.err(`${tag}${where}: ${i.message}`);
    }
    io.out(`${manifest ? `${manifest.id}@${manifest.version}: ` : ""}${errors.length} error(s), ${warnings.length} warning(s)`);
  }
  return errors.length > 0 || (values.strict && warnings.length > 0) ? 1 : 0;
}
