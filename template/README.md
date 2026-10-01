# __NAME__

An [AbuseMan](https://abuseman.abuse.ltd) extension.

## Develop

```sh
bun install
bun run dev        # abx dev: watch, rebuild and hot-reload in the running app
```

`abx dev` loads this folder into AbuseMan as an unpacked extension (Developer Mode) through the
app's dev socket and reloads it after every rebuild.

## Commands

| | |
|---|---|
| `abx build` | bundle `src/index.tsx` → `dist/main.js` |
| `abx lint` | validate `manifest.json` and check permissions against API usage |
| `abx pack` | create `__ID__-<version>.amx` |
| `abx publish` | upload to the AbuseMan store (needs a developer token: `ABX_TOKEN` or `~/.config/abx/token`) |

## How it fits together

- `manifest.json` declares permissions and static contributions (commands, menus, views, tools).
- `src/index.tsx` exports `defineExtension({ activate(ctx) { … } })`.
- `@abuseman/api`, `@abuseman/ui`, `react` and `zod` are **provided by the extension host at
  runtime** and are not bundled into `dist/main.js` (one shared React for native rendering).
  They are listed in `package.json` for types and editor support only.
