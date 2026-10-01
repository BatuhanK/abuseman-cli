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
  { re: /\.rules\s*\.\s*(create|delete)\s*\(/, permission: "proxy:modify", what: "ctx.rules" },
  { re: /\.(respond|abort|drop)\s*\(|\bheaders\s*\.\s*(set|append|delete)\s*\(|\.setBody\s*\(|action\s*:\s*["'](modify|respond|abort)["']/, permission: "proxy:modify", what: "modifying hook results", onlyWithHooks: true },
  { re: /\.commands\s*\.\s*register\s*\(/, permission: "ui", what: "ctx.commands.register" },
  { re: /\.ui\s*\.\s*(register\w*|toast|notify|quickPick|prompt|openView)\s*\(/, permission: "ui", what: "ctx.ui" },
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

/** First string-literal argument of every `pattern(` occurrence. */
function literalArgs(code: string, pattern: string): string[] {
  const re = new RegExp(`${pattern}\\s*\\(\\s*["'\`]([^"'\`]+)["'\`]`, "g");
  return [...code.matchAll(re)].map((m) => m[1]!);
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
  if (perms.has("proxy:modify") && !perms.has("flows:read")) warn(`"proxy:modify" without "flows:read": hooks cannot be registered`, "manifest.json");

  // static source scan
  const files = sourceFiles(dir);
  const used = new Map<Permission, { what: string; file: string }>();
  const registered = { commands: new Set<string>(), views: new Set<string>(), tools: new Set<string>(), interceptors: new Set<string>(), slash: new Set<string>() };
  let usesFetch = false;
  for (const file of files) {
    const code = readFileSync(file, "utf8");
    const rel = relative(dir, file);
    const hasHooks = USAGE[0]!.re.test(code);
    for (const u of USAGE) {
      if (u.onlyWithHooks && !hasHooks) continue;
      if (u.re.test(code) && !used.has(u.permission)) used.set(u.permission, { what: u.what, file: rel });
    }
    literalArgs(code, "\\.commands\\s*\\.\\s*register").forEach((x) => registered.commands.add(x));
    literalArgs(code, "\\.ui\\s*\\.\\s*register(?:View|InspectorTab|BodyViewer|SidebarSection|StatusItem|Sheet)").forEach((x) => registered.views.add(x));
    literalArgs(code, "\\.agent\\s*\\.\\s*registerSlashCommand").forEach((x) => registered.slash.add(x));
    for (const mt of code.matchAll(/\.tools\s*\.\s*register\s*\(\s*\{[\s\S]*?\bname\s*:\s*["'`]([^"'`]+)["'`]/g)) registered.tools.add(mt[1]!);
    for (const mt of code.matchAll(/\.interceptors\s*\.\s*registerProvider\s*\(\s*\{[\s\S]*?\bid\s*:\s*["'`]([^"'`]+)["'`]/g)) registered.interceptors.add(mt[1]!);
    if (/\bfetch\s*\(|\.net\s*\.\s*fetch\s*\(/.test(code)) usesFetch = true;
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
    for (const id of declared.commands) if (!registered.commands.has(id)) warn(`command "${id}" is declared but never registered (static scan)`);
    for (const id of declared.views) if (!registered.views.has(id)) warn(`view "${id}" is declared but no component is registered (static scan)`);
  }
  return { issues, manifest: m };
}
