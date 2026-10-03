# abuseman-cli

`abx`, the command-line tool for building [AbuseMan](https://abuseman.abuse.ltd) extensions:
scaffold a project, build it, check its manifest and permissions, run it live in the app, then pack,
sign and publish it to the Extension Store.

AbuseMan is an HTTP(S) debugging proxy for macOS. Extensions are TypeScript packages that run in a
sandboxed Bun process next to the app: they can hook into live traffic, add native UI and register
tools for MCP clients and the Assistant.

## Requirements

- [Bun](https://bun.sh) 1.4 or later (`abx` runs on Bun).
- AbuseMan with **Settings › Extensions › Developer mode** turned on, for `abx dev`.

## Create an extension

```sh
bun create abuseman-extension my-extension     # or: bunx abuseman-cli create my-extension
cd my-extension
bun install
bun run dev                                    # build, load into AbuseMan, hot-reload on save
```

The new project depends on `abuseman-cli`, so its scripts (`bun run build`, `bun run lint`, …) use
the version pinned in its `package.json`. The SDK (`@abuseman/api`, `@abuseman/ui`,
`@abuseman/schemas`) ships inside this package and is copied into the project's `.abuseman/sdk/`
(commit that folder). The project's `AGENTS.md` is a complete guide for coding agents.

To have `abx` on your `PATH` as well:

```sh
bun add --global abuseman-cli
```

## Commands

| Command | Does |
|---|---|
| `abx create <dir> [--id com.example.my-ext] [--name "My Extension"]` | scaffold a new extension |
| `abx build [dir] [--dev]` | bundle `src/index.ts(x)` → `dist/main.js` |
| `abx lint [dir] [--strict] [--json]` | validate `manifest.json`, check permissions and contributions against the code |
| `abx dev [dir] [--socket path]` | watch, rebuild and hot-reload in the running app |
| `abx pack [dir] [--sign key.pem] [-o out.amx]` | create a deterministic `.amx` package |
| `abx verify <file.amx> --pubkey <key>` | check the hashes and the signature of a package |
| `abx keygen <keyId> [--out dir]` | create an Ed25519 signing key |
| `abx publish [dir] [--token t]` | pack and upload to the Extension Store for review |

`abx publish` needs a developer token from Dashboard → Developer, passed with `--token`, the
`ABX_TOKEN` environment variable or `~/.config/abx/token`.

## Documentation

- [Extension SDK quickstart](https://abuseman.abuse.ltd/docs/extension-sdk)
- `AGENTS.md` in every project created by `abx create`: manifest, permissions, `when` clauses,
  the `ctx` API and the UI components.

## Source

This repository mirrors `packages/abx` of the AbuseMan monorepo, where the CLI is built (it bundles
the SDK packages that live next to it) and released to npm as `abuseman-cli`. Issues are welcome
here.

## License

[MIT](LICENSE)
