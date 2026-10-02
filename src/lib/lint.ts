/**
 * `abx lint`: manifest schema validation + best-effort static permission / contribution checks.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { satisfies, type Manifest as ManifestT, type Permission, Manifest } from "@abuseman/schemas";
import { readRawManifest } from "./manifest";
import { KNOWN_TOP_LEVEL, USAGE, callArgs, lintScript, mapSource, objectArgKey, SCRIPT_SOURCE_RE, type LintIssue, type ScriptLintOptions } from "./lint-core";

export { mapSource, lintScript, classifyImport, type LintIssue, type ScriptLintOptions } from "./lint-core";

/** App version the CLI targets for the `engines.abuseman` compatibility check. */
export const TARGET_APP_VERSION = "1.0.0";

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
  if (c.bodyViewers?.length && !perms.has("requests:read")) warn(`body viewers usually need "requests:read" to load bodies`, "manifest.json");

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
    objectArgKey(code, map, "\\.tools\\s*\\.\\s*register", "name").forEach((x) => registered.tools.add(x.value));
    objectArgKey(code, map, "\\.interceptors\\s*\\.\\s*registerProvider", "id").forEach((x) => registered.interceptors.add(x.value));
    // egress: only real `fetch(` calls count, not text inside strings / templates / comments (code generators)
    for (const m of code.matchAll(/\bfetch\s*\(|\.net\s*\.\s*fetch\s*\(/g)) {
      if (map.inCode[m.index!]) {
        usesFetch = true;
        break;
      }
    }
  }
  if (perms.has("proxy:modify") && !perms.has("requests:read") && usesProxyHooks) {
    warn(`"proxy:modify" without "requests:read": proxy hooks (ctx.proxy.on…) cannot be registered`, "manifest.json");
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

/**
 * Lints the user script in `dir` (`$SUPPORT/Scripts/<slug>`): every source file in the folder plus
 * its generated manifest. Same rules as the in-app check (see `lintScript`), imports included.
 */
export function lintScriptDir(dir: string, opts: ScriptLintOptions = { checkImports: true }): LintIssue[] {
  const files: Record<string, string> = {};
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      if (name === "node_modules" || name.startsWith(".")) continue;
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (SCRIPT_SOURCE_RE.test(name) || name.endsWith(".json")) files[relative(dir, full)] = readFileSync(full, "utf8");
    }
  };
  if (existsSync(dir)) walk(dir);
  return lintScript(files, opts);
}
