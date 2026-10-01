/**
 * `abx lint`: manifest schema validation + best-effort static permission / contribution checks.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { Manifest, satisfies, type Manifest as ManifestT, type Permission } from "@abuseman/schemas";
import { readRawManifest } from "./manifest";

export interface LintIssue {
  level: "error" | "warning";
  message: string;
  file?: string;
}

/** App version the CLI targets for the `engines.abuseman` compatibility check. */
export const TARGET_APP_VERSION = "1.0.0";

const KNOWN_TOP_LEVEL = new Set([
  "id", "name", "version", "description", "author", "icon", "categories", "engines", "main", "system",
  "permissions", "network", "hookTimeoutMs", "activationEvents", "contributes",
]);

/** Source pattern → permission it needs. */
const USAGE: { re: RegExp; permission: Permission; what: string; onlyWithHooks?: boolean }[] = [
  { re: /\.proxy\s*\.\s*on(Request|Response|WebSocketMessage)\s*\(/, permission: "flows:read", what: "proxy hooks" },
  { re: /\.flows\s*\.\s*(query|get|getBody|getBodyText)\s*\(/, permission: "flows:read", what: "ctx.flows reads" },
  { re: /\buse(Flow|FlowBody)\s*\(/, permission: "flows:read", what: "useFlow/useFlowBody" },
  { re: /\.flows\s*\.\s*(tag|annotate|replay)\s*\(/, permission: "flows:write", what: "ctx.flows writes" },
  { re: /\.http\s*\.\s*send\s*\(/, permission: "flows:write", what: "ctx.http.send" },
  { re: /\.rules\s*\.\s*(create|update|list|delete)\s*\(/, permission: "proxy:modify", what: "ctx.rules" },
  { re: /\.(respond|abort|drop)\s*\(|\bheaders\s*\.\s*(set|append|delete)\s*\(|\.setBody\s*\(|action\s*:\s*["'](modify|respond|abort)["']/, permission: "proxy:modify", what: "modifying hook results", onlyWithHooks: true },
  { re: /\.commands\s*\.\s*register\s*\(/, permission: "ui", what: "ctx.commands.register" },
  { re: /\.ui\s*\.\s*(register\w*|toast|notify|quickPick|prompt|openView|revealFlow)\s*\(/, permission: "ui", what: "ctx.ui" },
  { re: /\.ui\s*\.\s*clipboard\b/, permission: "clipboard", what: "ctx.ui.clipboard" },
  { re: /\.tools\s*\.\s*register\s*\(/, permission: "tools", what: "ctx.tools.register" },
  { re: /\.storage\s*\.\s*(get|set|delete|keys)\s*\(|\buseStorage\s*\(/, permission: "storage", what: "ctx.storage / useStorage" },
  { re: /\.secrets\s*\.\s*(get|set|delete)\s*\(/, permission: "secrets", what: "ctx.secrets" },
  { re: /\.interceptors\s*\.\s*registerProvider\s*\(/, permission: "interceptors", what: "ctx.interceptors.registerProvider" },
  { re: /\bBun\s*\.\s*spawn(Sync)?\s*\(|["'](node:)?child_process["']|\bBun\s*\.\s*\$/, permission: "process:spawn", what: "spawning processes" },
];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    if (!existsSync(d)) return;
    for (const name of readdirSync(d)) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(m?[jt]sx?)$/.test(name) && !/\.(test|spec)\./.test(name)) out.push(full);
    }
  };
  walk(join(dir, "src"));
  return out.sort();
}

/** Where the code is: which characters are real code, and where the string / template literals are. */
interface SourceMap {
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

interface Registrations {
  /** String-literal ids. */
  literal: string[];
  /** Some registration builds its id dynamically (variable, template with `${}`, concatenation). */
  dynamic: boolean;
}

/** First argument of every real-code `pattern(` call: literal ids vs. dynamic ones. */
function callArgs(code: string, map: SourceMap, pattern: string): Registrations {
  const out: Registrations = { literal: [], dynamic: false };
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
    else out.literal.push(code.slice(p + 1, lit.end));
  }
  return out;
}

/** `pattern({ …, key: "<literal>" })` — literal values of `key` in the object argument. */
function objectArgKey(code: string, map: SourceMap, pattern: string, key: string): string[] {
  const re = new RegExp(`${pattern}\\s*\\(\\s*\\{[\\s\\S]*?\\b${key}\\s*:\\s*(["'\`])`, "dg");
  const out: string[] = [];
  for (const m of code.matchAll(re)) {
    if (!map.inCode[m.index!]) continue;
    const q = m.indices![1]![0];
    const lit = map.literals.get(q);
    if (lit && !lit.hasExpr && lit.end > q) out.push(code.slice(q + 1, lit.end));
  }
  return out;
}

export function lintExtension(dir: string, opts: { appVersion?: string } = {}): { issues: LintIssue[]; manifest?: ManifestT } {
  const issues: LintIssue[] = [];
  const err = (message: string, file?: string) => issues.push({ level: "error", message, ...(file ? { file } : {}) });
  const warn = (message: string, file?: string) => issues.push({ level: "warning", message, ...(file ? { file } : {}) });

  let raw: unknown;
  try {
    raw = readRawManifest(dir);
  } catch (e) {
    err(e instanceof Error ? e.message : String(e));
    return { issues };
  }
  if (raw && typeof raw === "object") {
    for (const k of Object.keys(raw)) if (!KNOWN_TOP_LEVEL.has(k)) warn(`unknown manifest key "${k}"`, "manifest.json");
  }
  const parsed = Manifest.safeParse(raw);
  if (!parsed.success) {
    for (const i of parsed.error.issues) err(`${i.path.join(".") || "(root)"}: ${i.message}`, "manifest.json");
    return { issues };
  }
  const m = parsed.data;
  const c = m.contributes ?? {};
  const perms = new Set(m.permissions);

  // engines
  const appVersion = opts.appVersion ?? TARGET_APP_VERSION;
  if (!satisfies(appVersion, m.engines.abuseman)) warn(`engines.abuseman "${m.engines.abuseman}" does not match AbuseMan ${appVersion}`, "manifest.json");

  // files
  if (m.icon && !m.icon.startsWith("sf:") && !/^https?:/.test(m.icon) && !existsSync(join(dir, m.icon))) err(`icon file "${m.icon}" not found`, "manifest.json");
  if (!existsSync(join(dir, m.main))) warn(`main "${m.main}" not built yet (run abx build)`, "manifest.json");
  if (m.system) warn(`"system": true is only honored for first-party signed packages`, "manifest.json");

  // contribution / permission consistency
  const needsUi = (c.commands?.length ?? 0) + (c.sidebarSections?.length ?? 0) + (c.inspectorTabs?.length ?? 0) + (c.bodyViewers?.length ?? 0) + (c.statusItems?.length ?? 0) > 0;
  if (needsUi && !perms.has("ui")) err(`contributes commands/views but "ui" permission is missing`, "manifest.json");
  if (c.tools?.length && !perms.has("tools")) err(`contributes tools but "tools" permission is missing`, "manifest.json");
  if (c.interceptors?.length && !perms.has("interceptors")) err(`contributes interceptors but "interceptors" permission is missing`, "manifest.json");
  if (c.bodyViewers?.length && !perms.has("flows:read")) warn(`body viewers usually need "flows:read" to load bodies`, "manifest.json");

  // static source scan
  const files = sourceFiles(dir);
  const used = new Map<Permission, { what: string; file: string }>();
  const registered = { commands: new Set<string>(), views: new Set<string>(), tools: new Set<string>(), interceptors: new Set<string>(), slash: new Set<string>() };
  /** A registration id was built dynamically (variable / template / concatenation): ids are unknown. */
  const dynamic = { commands: false, views: false };
  let usesFetch = false;
  let usesProxyHooks = false;
  for (const file of files) {
    const code = readFileSync(file, "utf8");
    const rel = relative(dir, file);
    const map = mapSource(code);
    const hasHooks = USAGE[0]!.re.test(code);
    if (hasHooks) usesProxyHooks = true;
    for (const u of USAGE) {
      if (u.onlyWithHooks && !hasHooks) continue;
      if (u.re.test(code) && !used.has(u.permission)) used.set(u.permission, { what: u.what, file: rel });
    }
    const commands = callArgs(code, map, "\\.commands\\s*\\.\\s*register");
    commands.literal.forEach((x) => registered.commands.add(x));
    if (commands.dynamic) dynamic.commands = true;
    const views = callArgs(code, map, "\\.ui\\s*\\.\\s*register(?:View|InspectorTab|BodyViewer|SidebarSection|StatusItem|Sheet)");
    views.literal.forEach((x) => registered.views.add(x));
    if (views.dynamic) dynamic.views = true;
    callArgs(code, map, "\\.agent\\s*\\.\\s*registerSlashCommand").literal.forEach((x) => registered.slash.add(x));
    objectArgKey(code, map, "\\.tools\\s*\\.\\s*register", "name").forEach((x) => registered.tools.add(x));
    objectArgKey(code, map, "\\.interceptors\\s*\\.\\s*registerProvider", "id").forEach((x) => registered.interceptors.add(x));
    // egress: only real `fetch(` calls count, not text inside strings / templates / comments (code generators)
    for (const m of code.matchAll(/\bfetch\s*\(|\.net\s*\.\s*fetch\s*\(/g)) {
      if (map.inCode[m.index!]) {
        usesFetch = true;
        break;
      }
    }
  }
  if (perms.has("proxy:modify") && !perms.has("flows:read") && usesProxyHooks) {
    warn(`"proxy:modify" without "flows:read": proxy hooks (ctx.proxy.on…) cannot be registered`, "manifest.json");
  }
  for (const [p, u] of used) {
    if (!perms.has(p)) err(`${u.what} requires the "${p}" permission`, u.file);
  }
  if (files.length) {
    for (const p of perms) {
      if (p === "fs:home") continue;
      if (!used.has(p) && !(p === "ui" && needsUi)) warn(`permission "${p}" is declared but no usage was found (static scan)`, "manifest.json");
    }
  } else warn("no source files found under src/ — skipped static permission scan");
  if (usesFetch && !(m.network?.length)) warn(`fetch() is used but manifest "network" is empty: egress will be blocked`);

  const declared = {
    commands: new Set((c.commands ?? []).map((x) => x.id)),
    views: new Set([...(c.sidebarSections ?? []), ...(c.inspectorTabs ?? []), ...(c.bodyViewers ?? []), ...(c.statusItems ?? [])].map((x) => x.id)),
    tools: new Set((c.tools ?? []).map((x) => x.name)),
    interceptors: new Set((c.interceptors ?? []).map((x) => x.id)),
    slash: new Set((c.agentSlashCommands ?? []).map((x) => x.name)),
  };
  for (const id of registered.commands) if (!declared.commands.has(id)) err(`command "${id}" is registered in code but not declared in contributes.commands`);
  for (const id of registered.interceptors) if (!declared.interceptors.has(id)) err(`interceptor provider "${id}" is not declared in contributes.interceptors`);
  for (const id of registered.tools) if (!declared.tools.has(id)) warn(`tool "${id}" is not declared in contributes.tools (it works, but lazy activation via onTool and store review rely on it)`);
  for (const id of registered.slash) if (!declared.slash.has(id)) warn(`slash command "${id}" is not declared in contributes.agentSlashCommands`);
  if (files.length) {
    // with non-literal registrations (e.g. in a loop) the registered ids are unknown: stay quiet
    if (!dynamic.commands) for (const id of declared.commands) if (!registered.commands.has(id)) warn(`command "${id}" is declared but never registered (static scan)`);
    if (!dynamic.views) for (const id of declared.views) if (!registered.views.has(id)) warn(`view "${id}" is declared but no component is registered (static scan)`);
  }
  return { issues, manifest: m };
}
