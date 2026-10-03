# AGENTS.md — building the AbuseMan extension `__ID__`

Guide for AI coding agents (and humans) working on this project. AbuseMan is a macOS HTTP(S) debugging
proxy; an extension is a TypeScript bundle that runs in a sandboxed Bun process (the **extension host**)
next to the app and talks to it over IPC. Everything below matches the SDK in `.abuseman/sdk/`
(TypeScript sources: read `node_modules/@abuseman/api/src/context.ts` for the full `ctx` API and
`node_modules/@abuseman/ui/src/components.ts` for every UI component and prop).

## Vocabulary

- A captured HTTP exchange is a **request** (`CapturedRequest`, ids are `requestId`). Never call it a
  "flow". Its halves are the **request side** (`captured.request`) and **response side**
  (`captured.response`, may be `null`). Name a `CapturedRequest` variable `captured`, not `request`.
- The built-in AI chat is the **Assistant**. External tools (Claude Code, Codex …) are **agents**.
- Say **extension** (not plugin), **Extension Store** (not Store), **paused** (not intercepted).

## Layout

```
manifest.json      id, permissions, static contributions (drawn by the app before your code runs)
src/index.tsx      default export defineExtension({ activate(ctx) { … } }) + React views
dist/main.js       build output (abx build), referenced by manifest "main"
.abuseman/sdk/     @abuseman/{api,ui,schemas} tarballs (local SDK until published; commit it)
README.md          shipped in the .amx and shown to users
assets/, icon.png  optional, shipped in the .amx
```

`@abuseman/api`, `@abuseman/ui`, `react` (+ `react/jsx-runtime`) and `zod` are **provided by the host at
runtime** and stay external in `dist/main.js`. Any other npm dependency is bundled. There is no DOM
and no Node `http` server; code runs in Bun inside a sandbox (no file system outside the extension's
own folders, no process spawning, network only to `network` hosts — unless the permissions below
say otherwise).

## manifest.json (CONTRACTS §7)

```jsonc
{
  "id": "__ID__",                  // reverse-DNS, lowercase [a-z0-9.-], ≥ 2 labels, ≤ 128 chars
  "name": "__NAME__", "version": "0.1.0",          // semver; bump for every Extension Store upload
  "engines": { "abuseman": "^1.0.0" },
  "main": "dist/main.js",
  "permissions": ["requests:read", "ui"],          // as few as possible; abx lint checks usage
  "network": ["api.example.com", "*.example.org"], // egress allowlist for ctx.net.fetch (host globs)
  "hookTimeoutMs": 50,                             // per hook call, max 2000; slower hooks fail open
  "activationEvents": ["onStartup"],
  "contributes": { … }
}
```

**Permissions** (only these exist):

| Permission | Grants |
|---|---|
| `requests:read` | `ctx.requests.query/get/getBody/getBodyText`, `useRequest`/`useBody`, proxy hooks |
| `requests:write` | `ctx.requests.tag/annotate/replay`, `ctx.http.send` |
| `proxy:modify` | hooks may change/answer/abort traffic (`headers.set`, `setBody`, `respond`, `abort`, `drop`); `ctx.rules` |
| `ui` | commands, menus, views, toasts, quick pick, prompt, `revealRequest` |
| `tools` | `ctx.tools.register` (MCP clients and the Assistant) |
| `storage` / `secrets` | `ctx.storage` (JSON KV) / `ctx.secrets` (Keychain) |
| `clipboard` | `ctx.ui.clipboard.read/write` |
| `agent` | `ctx.agent.ask`, `ctx.agent.contributeContext` |
| `interceptors` | `ctx.interceptors.registerProvider` |
| `process:spawn`, `fs:home` | relax the sandbox (high risk; reviewed closely) |

**Activation events**: `onStartup`, `onHook`, `onCommand:<id>`, `onView:<id>`, `onTool:<name>`,
`onInterceptor:<id>`. If every event is `onCommand:`/`onView:`, the extension starts lazily on first
use; otherwise (or with none listed) it starts with the app. Hooks and tools need a running extension,
so keep `onStartup` (or `onHook` / `onTool:<name>`) when you register them.

**Contributions** (`contributes`; ids match `[A-Za-z0-9][A-Za-z0-9._:-]*`, prefix them with
`__PREFIX__.`). Each one declared here must be implemented in `activate`, and vice versa — `abx lint`
reports mismatches:

| Key | Shape | Implement with |
|---|---|---|
| `commands` | `{id, title, icon?, shortcut?: "cmd+shift+j", category?}` | `ctx.commands.register(id, handler)` |
| `menus` | `{ "<location>": [{command, when?, group?}] }`; locations `request/context`, `request/multi`, `header/context`, `body/selection`, `toolbar`, `menubar` (app Extensions menu), `sidebar/context` | (the command) |
| `inspectorTabs` | `{id, title, when?, order?, icon?}` | `ctx.ui.registerInspectorTab(id, C)`; props `{requestId}` |
| `bodyViewers` | `{id, title, mime: ["application/x-msgpack", "image/"], when?}` | `ctx.ui.registerBodyViewer(id, C)`; props `{requestId, which}` |
| `sidebarSections` | `{id, title, icon?, when?}` | `ctx.ui.registerSidebarSection(id, C)` |
| `statusItems` | `{id, title, icon?}` | `ctx.ui.registerStatusItem(id, C)` |
| `settings` | `{key, type: boolean\|string\|number\|enum, title, description?, default?, options?}` | `ctx.settings.get(key, fallback)`, `useSetting` |
| `tools` | `{name, description, risk: read\|write\|dangerous}` | `ctx.tools.register({name, …})` (input schema at runtime) |
| `agentSlashCommands` | `{name, description}` | `ctx.agent.registerSlashCommand(name, handler)` |
| `interceptors` | `{id, title, kind, icon?}` | `ctx.interceptors.registerProvider({id, targets, activate, deactivate})` |

Sheets have no manifest entry: `ctx.ui.registerSheet(id, C)` + `ctx.ui.openView(id, props)`.
Icons are `sf:<SF Symbol name>` (e.g. `sf:key.fill`) or a relative PNG path.

## `when` clauses (CONTRACTS §3)

Boolean expressions on menus, inspector tabs, body viewers and sidebar sections, evaluated by the app:
operators `&& || ! == != =~ > < >= <=`, strings in quotes, `=~` takes a regex string. Context:
`capturedRequest` (or null), `request.*` / `response.*` (the sides, plus `url` and `mime`),
`selection.count`, `selection.text`, `selection.requestIds`, `view`, `proxy.running`, `license.plan`.
Functions: `request.hasHeader('x')`, `response.hasHeader('x')`, `matches('<filter DSL>')`,
`license.has('<feature>')`. Examples:

```
request.hasHeader('authorization')
response.status >= 400 && response.mime =~ 'json'
matches('host:*.example.com method:POST')
```

## SDK surface (`@abuseman/api`)

`export default defineExtension({ activate(ctx) { … }, deactivate?() { … } })`. Everything `register*` /
`on*` returns a `Disposable`; it is cleaned up automatically on deactivate (`ctx.subscriptions` for
your own).

- **Hooks** — `ctx.proxy.onRequest(match, (req: HookedRequest) => …)`, `onResponse(match, (res:
  HookedResponse) => …)`, `onWebSocketMessage(match, (msg: HookedWebSocketMessage) => …)`. `match` is a
  filter DSL string (`"host:api.x.com status:>=400"`, `"*"` = everything) or the `f` builder:
  `f.host("*.x.com").and(f.method("POST"), f.status(">=", 400))`, also `f.path/url/mime/header/
  reqHeader/resHeader/body/source/tag/protocol/state/size/duration/is/any/all/not/raw`. The match runs
  in the app; only matching requests reach your code, so keep it narrow.
  - `HookedRequest`: `method`, `url`, `host`, `path`, `query`, `headers` (`get/getAll/has/set/append/
    delete`), `body` (inlined text ≤ 256 KiB or `undefined`), `await req.text()`, `await req.json()`,
    `req.setBody(stringOrBytesOrObject)`, `req.respond({status, headers, body})`, `req.abort(reason?)`,
    plus `id`, `source`, `tags`, `tls`, `snapshot` (the `CapturedRequest`).
  - `HookedResponse`: `status`, `reason`, `headers`, `body`/`text()`/`json()`/`setBody()`, `timing`,
    `abort()`, and `res.request` (read-only request side).
  - Mutate and return nothing (or `"continue"`). Mutations need `proxy:modify`. Hooks must finish in
    `hookTimeoutMs`; otherwise the request continues unchanged.
- **Requests** — `ctx.requests.query({filter, limit ≤ 500, offset, sort})` → `{requests, total}`,
  `get(id)` → `CapturedRequest`, `getBody(id, "request"|"response", {offset, length, decode, encoding})`,
  `getBodyText(id, which)`, `tag(ids, {add, remove})`, `annotate(id, note)`, `replay(id, patch?, {fingerprint?})` → new id.
- **Send** — `ctx.http.send({method, url, headers, body, fingerprint})` → id of the captured request
  (goes through the proxy and appears in the request list). `fingerprint` (also on `replay`) picks the
  TLS + HTTP/2 fingerprint: `"auto"` (default — the ClientHello a client last sent to that host),
  `"chrome"`, `"firefox"`, `"safari"`, `"edge"`, `"ios"`, `"android"`, a pinned version like
  `"chrome-133"`, or `"abuseman"`. `ctx.net.fetch` is direct egress, limited to `network`, and always
  uses Bun's own TLS.
- **Rules** — `ctx.rules.create({name, match, action, phase?, enabled?, priority?})`, `update`,
  `delete`, `list` (own rules only). Actions: `mock`, `mapLocal`, `mapRemote`, `setHeaders`,
  `rewriteBody`, `delay`, `throttle`, `block`, `breakpoint` (see `RuleAction` in `@abuseman/schemas`).
- **Commands** — `ctx.commands.register(id, (context) => …)`; `context` is the `when` context:
  `context.capturedRequest` for `request/context`, `context.selection?.requestIds` for `request/multi`.
- **UI** — `ctx.ui.toast(msg, "info"|"success"|"error")`, `notify(title, body)`, `quickPick(items)` →
  id or `null`, `prompt({title, placeholder, value})` → text or `null`, `openView(id, props)`,
  `revealRequest(requestId)` (select it in the main request list), `clipboard.read/write`.
- **Tools** — `ctx.tools.register({name, description, input: z.object({…}), risk, run})`; `run` returns
  a string, JSON, `ToolContent[]` or a `ToolResult`. Exposed as `ext.<id with dots → _>.<name>`.
- **Storage** — `ctx.storage.get/set/delete/keys` (JSON), `ctx.secrets.get/set/delete`,
  `ctx.settings.get(key, fallback)` / `onChange`.
- **Assistant** — `ctx.agent.ask(prompt, {attachments: [{type: "request", id}], newChat})` (prefills,
  never sends), `contributeContext(name, () => text)`, `registerSlashCommand`,
  `registerToolResultRenderer(toolName, C)`.
- **Misc** — `ctx.log.debug/info/warn/error(msg, data?)` (extension log panel), `ctx.license.has(feature)`,
  `ctx.extension` (`id`, `version`, `dataDir`, `hasPermission(p)`).

## Views (`@abuseman/ui`)

Views are React 19 function components built **only** from `@abuseman/ui` host components (no DOM,
no HTML elements); the app renders them natively with SwiftUI. Event handlers run in the extension.

- Layout: `VStack`, `HStack`, `ScrollView`, `Section`, `Divider`, `Spacer`.
- Content: `Text` (`value` or string children, `style`, `color`), `Image` (`systemName` | `url`),
  `Badge`, `ProgressView`, `Button` (`title`, `onPress`), `Detail` (markdown), `KeyValue`, `CodeView`,
  `HexView` (base64), `Chart`, `WebView` (escape hatch).
- Lists: `List`, `ListSection`, `ListItem` (`id`, `title`, `actions`), `Table` (`columns`, `rows`).
- Forms: `Form` (`onSubmit`), `TextField`, `TextArea`, `Toggle`, `Picker`.
- Hooks: `useRequest(requestId)` → `{capturedRequest, isLoading, error, reload}`,
  `useBody(requestId, which, opts?)` → `{data: {text, base64, …}, isLoading, error}`,
  `useSetting(key, fallback)`, `useStorage(key, initial)` → `[value, set, {isLoading, error}]`, `useNavigation()`
  (`push/pop`), `useView()`.
- Colors: `primary | secondary | red | green | orange | blue`.

## Dev loop

1. AbuseMan running with **Settings › Extensions › Developer mode** on (it opens the dev socket
   `~/Library/Application Support/AbuseMan/run/dev.sock`; override with `abx dev --socket` or
   `ABUSEMAN_DEV_SOCKET`).
2. `bun install`, then `bun run dev` (= `abx dev`): builds, loads this folder as an unpacked
   **Development** extension (`dev.loadUnpacked`), and rebuilds + reloads on every change to `src/`,
   `assets/`, `manifest.json`. Errors from `activate` and `ctx.log` output show in the app's extension
   log panel, not in the terminal.
3. Before finishing a change: `bun run typecheck && bun run build && bun run lint`.

## Build, pack, sign, publish (`abx`)

| Command | Does |
|---|---|
| `abx build [--dev]` | bundle `src/index.ts(x)` → `main` (ESM, target bun, host modules external) |
| `abx lint [--strict] [--json]` | validate the manifest; check permissions and contributions against the code |
| `abx pack [--sign key.pem] [-o out.amx]` | deterministic `.amx` (manifest, dist, README, icon, assets) |
| `abx keygen <keyId> [--out dir]` | new Ed25519 signing key |
| `abx verify file.amx --pubkey <key>` | check hashes and signature |
| `abx publish [--token t]` | pack and upload to the Extension Store for review (`ABX_TOKEN` or `~/.config/abx/token`) |

## Testing

Keep it light: put pure logic (parsers, decoders, formatting) in plain modules under `src/` with no
SDK calls and cover those with `bun test`. For the rest, `typecheck` + `lint` + `build`, then try it
in the app with `bun run dev`. Don't build mocks of the extension host.

## Reference

- Website docs: https://abuseman.abuse.ltd/docs/extension-sdk
- Contracts (in the AbuseMan repo, `docs/CONTRACTS.md`): §2 filter DSL, §3 `when` expressions, §7 manifest
  and `.amx`, §8 extension host IPC and host components, §9 tools, §10 rules, §11 interceptors,
  §13 dev socket. Vocabulary: `docs/GLOSSARY.md`.
