/**
 * Lint core shared by `abx lint` (extensions, `lint.ts`) and the script language service
 * (`packages/script-language-service`, which bundles this file): no file system access, only
 * source text in, issues out.
 *
 * - {@link mapSource}: best-effort lexer telling code from comments / strings / regexes.
 * - {@link USAGE}: source patterns → the permission they need.
 * - {@link lintScript}: the user-script layout (`<slug>/main.ts` entry, every source file in the
 *   folder, generated manifest with `x-*` keys).
 * - {@link classifyImport}: which module specifiers a script may import.
 */
import { HOST_PROVIDED_MODULES, Manifest, type Permission } from "@abuseman/schemas";

export interface LintIssue {
  level: "error" | "warning";
  message: string;
  file?: string;
  /** 1-based position of the issue in `file` (script lint only). */
  line?: number;
  column?: number;
  endLine?: number;
  endColumn?: number;
  /** Rule id (script lint only), e.g. `permission`, `import`, `command-undeclared`. */
  rule?: string;
}

/** Manifest keys the app understands. */
export const KNOWN_TOP_LEVEL = new Set([
  "id", "name", "version", "description", "author", "icon", "categories", "engines", "main", "system",
  "permissions", "network", "hookTimeoutMs", "activationEvents", "contributes",
]);

/** Source pattern → permission it needs. */
export const USAGE: { re: RegExp; permission: Permission; what: string; onlyWithHooks?: boolean }[] = [
  { re: /\.proxy\s*\.\s*on(Request|Response|WebSocketMessage)\s*\(/, permission: "requests:read", what: "proxy hooks" },
  { re: /\.requests\s*\.\s*(query|get|getBody|getBodyText)\s*\(/, permission: "requests:read", what: "ctx.requests reads" },
  { re: /\buse(Request|Body)\s*\(/, permission: "requests:read", what: "useRequest/useBody" },
  { re: /\.requests\s*\.\s*(tag|annotate|replay)\s*\(/, permission: "requests:write", what: "ctx.requests writes" },
  { re: /\.http\s*\.\s*send\s*\(/, permission: "requests:write", what: "ctx.http.send" },
  { re: /\.rules\s*\.\s*(create|update|list|delete)\s*\(/, permission: "proxy:modify", what: "ctx.rules" },
  { re: /\.(respond|abort|drop)\s*\(|\bheaders\s*\.\s*(set|append|delete)\s*\(|\.setBody\s*\(|action\s*:\s*["'](modify|respond|abort)["']/, permission: "proxy:modify", what: "modifying hook results", onlyWithHooks: true },
  { re: /\.commands\s*\.\s*register\s*\(/, permission: "ui", what: "ctx.commands.register" },
  { re: /\.ui\s*\.\s*(register\w*|toast|notify|quickPick|prompt|openView|revealRequest)\s*\(/, permission: "ui", what: "ctx.ui" },
  { re: /\.ui\s*\.\s*clipboard\b/, permission: "clipboard", what: "ctx.ui.clipboard" },
  { re: /\.tools\s*\.\s*register\s*\(/, permission: "tools", what: "ctx.tools.register" },
  { re: /\.storage\s*\.\s*(get|set|delete|keys)\s*\(|\buseStorage\s*\(/, permission: "storage", what: "ctx.storage / useStorage" },
  { re: /\.secrets\s*\.\s*(get|set|delete)\s*\(/, permission: "secrets", what: "ctx.secrets" },
  { re: /\.interceptors\s*\.\s*registerProvider\s*\(/, permission: "interceptors", what: "ctx.interceptors.registerProvider" },
  { re: /\.agent\s*\.\s*(ask|contributeContext)\s*\(/, permission: "agent", what: "ctx.agent.ask / contributeContext" },
  { re: /\.agent\s*\.\s*registerToolResultRenderer\s*\(/, permission: "ui", what: "ctx.agent.registerToolResultRenderer" },
  { re: /\bBun\s*\.\s*spawn(Sync)?\s*\(|["'](node:)?child_process["']|\bBun\s*\.\s*\$/, permission: "process:spawn", what: "spawning processes" },
];

// ───────────────────────────── lexer ─────────────────────────────

/** Where the code is: which characters are real code, and where the string / template literals are. */
export interface SourceMap {
  /** `1` for code (incl. `${…}` expressions inside templates), `0` for comments, string and template text. */
  inCode: Uint8Array;
  /** Opening quote index → closing quote index and whether a template literal has `${…}` parts. */
  literals: Map<number, { end: number; hasExpr: boolean }>;
}

const REGEX_PRECEDERS = new Set(["", "(", ",", "=", ":", "[", "!", "&", "|", "?", "{", "}", ";", "+", "-", "*", "%", "<", ">", "~", "^"]);
const REGEX_KEYWORDS = new Set(["return", "typeof", "case", "delete", "void", "throw", "in", "of", "new", "yield", "await", "else", "do"]);

/**
 * Best-effort lexer (no parser): finds comments, string / template literals (with nested `${…}`) and
 * regex literals so source patterns only match real code. Never throws; unterminated input is
 * treated as running to the end of the line / file.
 */
export function mapSource(code: string): SourceMap {
  const n = code.length;
  const inCode = new Uint8Array(n).fill(1);
  const literals: SourceMap["literals"] = new Map();
  const frames: { open: number; depth: number }[] = [];
  const blank = (a: number, b: number) => inCode.fill(0, a, Math.min(b, n));

  /** Scan template text from `j` up to the closing backtick or the next `${`; returns the next index. */
  const scanTemplate = (open: number, start: number): number => {
    const lit = literals.get(open)!;
    let j = start;
    while (j < n) {
      const ch = code[j]!;
      if (ch === "\\") {
        blank(j, j + 2);
        j += 2;
      } else if (ch === "`") {
        inCode[j] = 0;
        lit.end = j;
        return j + 1;
      } else if (ch === "$" && code[j + 1] === "{") {
        blank(j, j + 2);
        lit.hasExpr = true;
        frames.push({ open, depth: 0 });
        return j + 2;
      } else {
        inCode[j] = 0;
        j++;
      }
    }
    lit.end = n;
    return j;
  };

  let i = 0;
  let prev = ""; // last significant character class
  let prevWord = "";
  while (i < n) {
    const ch = code[i]!;
    if (ch === "/" && code[i + 1] === "/") {
      const j = code.indexOf("\n", i);
      const end = j < 0 ? n : j;
      blank(i, end);
      i = end;
      continue;
    }
    if (ch === "/" && code[i + 1] === "*") {
      const j = code.indexOf("*/", i + 2);
      const end = j < 0 ? n : j + 2;
      blank(i, end);
      i = end;
      continue;
    }
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < n && code[j] !== ch && code[j] !== "\n") j += code[j] === "\\" ? 2 : 1;
      literals.set(i, { end: j, hasExpr: false });
      blank(i, j + 1);
      i = j + 1;
      prev = "s";
      continue;
    }
    if (ch === "`") {
      inCode[i] = 0;
      literals.set(i, { end: -1, hasExpr: false });
      i = scanTemplate(i, i + 1);
      prev = "s";
      continue;
    }
    const top = frames[frames.length - 1];
    if (top && ch === "{") top.depth++;
    else if (top && ch === "}") {
      if (top.depth === 0) {
        frames.pop();
        inCode[i] = 0;
        i = scanTemplate(top.open, i + 1);
        prev = "s";
        continue;
      }
      top.depth--;
    }
    if (ch === "/" && (REGEX_PRECEDERS.has(prev) || (prev === "w" && REGEX_KEYWORDS.has(prevWord)))) {
      let j = i + 1;
      let inClass = false;
      while (j < n && code[j] !== "\n") {
        const c = code[j]!;
        if (c === "\\") {
          j += 2;
          continue;
        }
        if (c === "[") inClass = true;
        else if (c === "]") inClass = false;
        else if (c === "/" && !inClass) break;
        j++;
      }
      if (code[j] === "/") {
        j++;
        while (j < n && /[a-z]/.test(code[j]!)) j++;
        blank(i, j);
        i = j;
        prev = "r";
        continue;
      }
    }
    if (/[A-Za-z_$]/.test(ch)) {
      let j = i + 1;
      while (j < n && /[\w$]/.test(code[j]!)) j++;
      prevWord = code.slice(i, j);
      prev = "w";
      i = j;
      continue;
    }
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    prev = /\d/.test(ch) ? "n" : ch;
    prevWord = "";
    i++;
  }
  return { inCode, literals };
}

export interface Registrations {
  /** String-literal ids. */
  literal: string[];
  /** Index of each literal id's call (parallel to `literal`). */
  at: number[];
  /** Some registration builds its id dynamically (variable, template with `${}`, concatenation). */
  dynamic: boolean;
}

/** First argument of every real-code `pattern(` call: literal ids vs. dynamic ones. */
export function callArgs(code: string, map: SourceMap, pattern: string): Registrations {
  const out: Registrations = { literal: [], at: [], dynamic: false };
  const re = new RegExp(`${pattern}\\s*\\(\\s*`, "g");
  for (const m of code.matchAll(re)) {
    if (!map.inCode[m.index!]) continue;
    const p = m.index! + m[0].length;
    const lit = map.literals.get(p);
    if (!lit || lit.hasExpr || lit.end < 0) {
      if (p < code.length && code[p] !== ")") out.dynamic = true;
      continue;
    }
    // `"a" + b` is not a literal id
    const next = /^\s*(.)/.exec(code.slice(lit.end + 1, lit.end + 64))?.[1];
    if (next !== "," && next !== ")") out.dynamic = true;
    else {
      out.literal.push(code.slice(p + 1, lit.end));
      out.at.push(m.index!);
    }
  }
  return out;
}

/** `pattern({ …, key: "<literal>" })` — literal values of `key` in the object argument, with the call's index. */
export function objectArgKey(code: string, map: SourceMap, pattern: string, key: string): { value: string; index: number }[] {
  const re = new RegExp(`${pattern}\\s*\\(\\s*\\{[\\s\\S]*?\\b${key}\\s*:\\s*(["'\`])`, "dg");
  const out: { value: string; index: number }[] = [];
  for (const m of code.matchAll(re)) {
    if (!map.inCode[m.index!]) continue;
    const q = m.indices![1]![0];
    const lit = map.literals.get(q);
    if (lit && !lit.hasExpr && lit.end > q) out.push({ value: code.slice(q + 1, lit.end), index: m.index! });
  }
  return out;
}

/** Index of the first match of `re` that starts in real code, or -1. */
export function firstInCode(code: string, map: SourceMap, re: RegExp): { index: number; length: number } | undefined {
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  for (const m of code.matchAll(g)) {
    if (map.inCode[m.index!]) return { index: m.index!, length: m[0].length };
  }
  return undefined;
}

/** 1-based line / column (UTF-16) of `index` in `text`. */
export function lineColumn(text: string, index: number): { line: number; column: number } {
  let line = 1;
  let lineStart = 0;
  const end = Math.max(0, Math.min(index, text.length));
  for (let i = 0; i < end; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: end - lineStart + 1 };
}

// ───────────────────────────── scripts ─────────────────────────────

/** Entry file of a user script, relative to its folder. */
export const SCRIPT_ENTRY = "main.ts";

/** Permissions the app grants every script (mirrors `ScriptStore.writeManifest`). */
export const SCRIPT_PERMISSIONS: readonly Permission[] = ["requests:read", "requests:write", "proxy:modify", "ui", "tools", "storage"];

/** Source files a script may contain (everything else in the folder is data). */
export const SCRIPT_SOURCE_RE = /\.(m?[jt]sx?|[cm]ts)$/;

export type ImportVerdict =
  | { kind: "relative"; resolved: string }
  | { kind: "host" }
  | { kind: "builtin"; level: "warning"; message: string }
  | { kind: "rejected"; level: "error"; message: string };

const HOST_MODULES = new Set<string>(HOST_PROVIDED_MODULES);
const HOST_LIST = "@abuseman/api, @abuseman/ui, react, react/jsx-runtime, zod, zod/v4";

/**
 * Whether a script file (`from`, relative to the script folder, e.g. `lib/util.ts`) may import
 * `specifier`. Relative imports must stay inside the folder; bare specifiers must be host modules.
 */
export function classifyImport(from: string, specifier: string): ImportVerdict {
  if (specifier.startsWith("./") || specifier.startsWith("../") || specifier === "." || specifier === "..") {
    const parts = from.split("/").slice(0, -1);
    for (const seg of specifier.split("/")) {
      if (seg === "" || seg === ".") continue;
      if (seg === "..") {
        if (parts.length === 0) {
          return { kind: "rejected", level: "error", message: `Import "${specifier}" leaves the script folder. Scripts can only import files inside their own folder.` };
        }
        parts.pop();
      } else parts.push(seg);
    }
    return { kind: "relative", resolved: parts.join("/") };
  }
  if (specifier.startsWith("/") || /^[A-Za-z]:[\\/]/.test(specifier) || specifier.startsWith("file:")) {
    return { kind: "rejected", level: "error", message: `Import "${specifier}" is an absolute path. Scripts can only import files inside their own folder, with relative paths ("./util.ts").` };
  }
  if (HOST_MODULES.has(specifier)) return { kind: "host" };
  if (specifier.startsWith("node:") || specifier.startsWith("bun:") || specifier === "bun") {
    return { kind: "builtin", level: "warning", message: `"${specifier}" is a runtime built-in without type declarations for scripts; the script sandbox blocks most of it (no network, no processes, no files outside the script folder).` };
  }
  return {
    kind: "rejected",
    level: "error",
    message: `Cannot import "${specifier}": npm packages are not available to scripts. Import files of this script with relative paths ("./util.ts") or the host modules ${HOST_LIST}.`,
  };
}

/** Module specifiers in source text (static/dynamic imports, re-exports, `require`), with their index (opening quote + 1). */
export function importSpecifiers(code: string, map: SourceMap = mapSource(code)): { specifier: string; index: number }[] {
  const out: { specifier: string; index: number }[] = [];
  const re = /\b(?:import|export)\b[^;'"`]*?\bfrom\s*(["'])|\bimport\s*(["'])|\b(?:import|require)\s*\(\s*(["'])/dg;
  for (const m of code.matchAll(re)) {
    if (!map.inCode[m.index!]) continue;
    const group = m.indices![1] ?? m.indices![2] ?? m.indices![3];
    if (!group) continue;
    const q = group[0];
    const lit = map.literals.get(q);
    if (!lit || lit.end <= q) continue;
    out.push({ specifier: code.slice(q + 1, lit.end), index: q + 1 });
  }
  return out;
}

export interface ScriptLintOptions {
  /** Also report imports that leave the folder or aren't host modules (the language service reports these itself). */
  checkImports?: boolean;
}

/**
 * Lints a user script. `files` maps paths relative to the script folder (`main.ts`,
 * `lib/util.ts`, `manifest.json`) to their text. Every issue carries a `file` and a 1-based
 * position.
 */
export function lintScript(files: Record<string, string>, opts: ScriptLintOptions = {}): LintIssue[] {
  const issues: LintIssue[] = [];
  const at = (file: string, text: string | undefined, index: number, length = 0) => {
    if (text === undefined || index < 0) return { file, line: 1, column: 1, endLine: 1, endColumn: 1 };
    const a = lineColumn(text, index);
    const b = lineColumn(text, index + length);
    return { file, line: a.line, column: a.column, endLine: b.line, endColumn: b.column };
  };
  const push = (level: LintIssue["level"], rule: string, message: string, pos: ReturnType<typeof at>) =>
    issues.push({ level, rule, message, ...pos });

  // manifest (generated by the app; `x-*` keys are app metadata such as `x-enabled`)
  let permissions = new Set<Permission>(SCRIPT_PERMISSIONS);
  let network: string[] = [];
  let contributes: Record<string, { id?: string; name?: string }[] | undefined> = {};
  const manifestText = files["manifest.json"];
  if (manifestText !== undefined) {
    const mpos = at("manifest.json", manifestText, 0);
    let raw: unknown;
    try {
      raw = JSON.parse(manifestText);
    } catch (e) {
      push("error", "manifest", `manifest.json is not valid JSON: ${e instanceof Error ? e.message : String(e)}`, mpos);
    }
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      for (const k of Object.keys(raw)) {
        if (!KNOWN_TOP_LEVEL.has(k) && !k.startsWith("x-")) {
          push("warning", "manifest", `unknown manifest key "${k}"`, at("manifest.json", manifestText, manifestText.indexOf(`"${k}"`), k.length + 2));
        }
      }
      const parsed = Manifest.safeParse(raw);
      if (!parsed.success) {
        for (const i of parsed.error.issues) push("error", "manifest", `${i.path.join(".") || "(root)"}: ${i.message}`, mpos);
      } else {
        const m = parsed.data;
        permissions = new Set(m.permissions);
        network = m.network ?? [];
        contributes = (m.contributes ?? {}) as typeof contributes;
        if (m.main !== SCRIPT_ENTRY) {
          push("error", "manifest", `"main" is "${m.main}", but a script's entry is always ${SCRIPT_ENTRY}`, at("manifest.json", manifestText, manifestText.indexOf('"main"'), 6));
        }
      }
    }
  }

  // entry
  const entry = files[SCRIPT_ENTRY];
  if (entry === undefined) {
    push("error", "entry", `missing ${SCRIPT_ENTRY}: the script's entry file must be at the root of its folder`, at(SCRIPT_ENTRY, undefined, 0));
  } else {
    const map = mapSource(entry);
    if (!firstInCode(entry, map, /\bexport\s+default\b/)) {
      push("error", "entry", `${SCRIPT_ENTRY} has no default export: end it with \`export default defineExtension({ activate(ctx) { … } })\``, at(SCRIPT_ENTRY, entry, 0));
    }
  }

  // static scan over every source file in the folder
  const sources = Object.keys(files).filter((f) => SCRIPT_SOURCE_RE.test(f) && !f.endsWith(".d.ts")).sort();
  const scanned = sources.map((file) => ({ file, code: files[file]!, map: mapSource(files[file]!) }));
  const usesHooks = scanned.some((s) => firstInCode(s.code, s.map, USAGE[0]!.re));
  const reported = new Set<Permission>();
  const declared = {
    commands: new Set((contributes.commands ?? []).map((x) => x.id)),
    interceptors: new Set((contributes.interceptors ?? []).map((x) => x.id)),
    slash: new Set((contributes.agentSlashCommands ?? []).map((x) => x.name)),
  };
  let fetchReported = false;
  for (const { file, code, map } of scanned) {
    for (const u of USAGE) {
      if (u.onlyWithHooks && !usesHooks) continue;
      if (permissions.has(u.permission) || reported.has(u.permission)) continue;
      const hit = firstInCode(code, map, u.re);
      if (!hit) continue;
      reported.add(u.permission);
      push("error", "permission", `${u.what} requires the "${u.permission}" permission, which scripts don't have`, at(file, code, hit.index, hit.length));
    }

    const commands = callArgs(code, map, "\\.commands\\s*\\.\\s*register");
    commands.literal.forEach((id, i) => {
      if (!declared.commands.has(id)) {
        push("error", "command-undeclared", `command "${id}" can't be registered: scripts have no contributes.commands, so ctx.commands.register fails at runtime`, at(file, code, commands.at[i]!));
      }
    });
    const slash = callArgs(code, map, "\\.agent\\s*\\.\\s*registerSlashCommand");
    slash.literal.forEach((name, i) => {
      if (!declared.slash.has(name)) push("warning", "slash-undeclared", `slash command "${name}" is not declared in contributes.agentSlashCommands`, at(file, code, slash.at[i]!));
    });
    for (const p of objectArgKey(code, map, "\\.interceptors\\s*\\.\\s*registerProvider", "id")) {
      if (!declared.interceptors.has(p.value)) push("error", "interceptor-undeclared", `interceptor provider "${p.value}" is not declared in contributes.interceptors`, at(file, code, p.index));
    }

    if (!fetchReported && network.length === 0) {
      const hit = firstInCode(code, map, /\bfetch\s*\(|\.net\s*\.\s*fetch\s*\(/);
      if (hit) {
        fetchReported = true;
        push("warning", "network", `fetch() is used but scripts have no network access (manifest "network" is empty): requests will be blocked`, at(file, code, hit.index, hit.length));
      }
    }

    if (opts.checkImports) {
      for (const imp of importSpecifiers(code, map)) {
        const v = classifyImport(file, imp.specifier);
        if (v.kind === "rejected" || v.kind === "builtin") push(v.level, "import", v.message, at(file, code, imp.index, imp.specifier.length));
        else if (v.kind === "relative" && !resolvesInFolder(files, v.resolved)) {
          push("error", "import", `Cannot find "${imp.specifier}" in the script folder`, at(file, code, imp.index, imp.specifier.length));
        }
      }
    }
  }
  return issues;
}

/** Whether a resolved relative import (`lib/util`, `lib/util.ts`, `util.js`) names a file in `files`. */
function resolvesInFolder(files: Record<string, string>, resolved: string): boolean {
  const candidates = [resolved, ...["ts", "tsx", "mts", "js", "mjs", "json"].map((e) => `${resolved}.${e}`), `${resolved}/index.ts`];
  if (/\.m?js$/.test(resolved)) candidates.push(resolved.replace(/\.(m?)js$/, ".$1ts"), resolved.replace(/\.js$/, ".tsx"));
  return candidates.some((c) => c in files);
}
