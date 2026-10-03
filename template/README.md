# __NAME__

An [AbuseMan](https://abuseman.abuse.ltd) extension.

## Develop

Requirements: [Bun](https://bun.sh) 1.4+, the `abx` CLI on your `PATH` (from an AbuseMan checkout:
`make abx-install`), and AbuseMan running with **Settings › Extensions › Developer mode** on.

```sh
bun install
bun run dev        # abx dev: build, load into AbuseMan, rebuild + hot-reload on every save
```

`abx dev` loads this folder into the running app as an unpacked **Development** extension through the
app's dev socket (`~/Library/Application Support/AbuseMan/run/dev.sock`) and reloads it after every
rebuild. Its logs appear in the app's extension log panel.

## Scripts

| | |
|---|---|
| `bun run build` | `abx build`: bundle `src/index.tsx` → `dist/main.js` |
| `bun run lint` | `abx lint`: validate `manifest.json`, check permissions against API usage |
| `bun run typecheck` | `tsc --noEmit` |
| `bun run pack` | `abx pack`: create `__ID__-<version>.amx` (`--sign <key.pem>` to sign) |
| `abx publish` | upload to the Extension Store (developer token: `ABX_TOKEN` or `~/.config/abx/token`) |

## How it fits together

- `manifest.json` declares the id, permissions and static contributions (commands, menus, inspector
  tabs, tools …). The app draws them before your code runs.
- `src/index.tsx` default-exports `defineExtension({ activate(ctx) { … } })` and implements them.
- `@abuseman/api`, `@abuseman/ui`, `react` and `zod` are **provided by the extension host at
  runtime** and are not bundled into `dist/main.js`. They are installed for types and editor support.
- Until the SDK is published on npm, `@abuseman/*` come from the tarballs in `.abuseman/sdk/`
  (keep that folder in version control).

See `AGENTS.md` for the full guide and https://abuseman.abuse.ltd/docs/extension-sdk.
