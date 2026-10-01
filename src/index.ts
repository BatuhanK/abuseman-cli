/**
 * `abx` — AbuseMan extension CLI.
 */
import { build } from "./commands/build";
import { create } from "./commands/create";
import { dev } from "./commands/dev";
import { keygen } from "./commands/keygen";
import { lint } from "./commands/lint";
import { pack } from "./commands/pack";
import { publish } from "./commands/publish";
import { verifyCmd } from "./commands/verify";
import { color, consoleIO, type IO } from "./lib/io";
import { CliError } from "./lib/manifest";

export { buildExtension } from "./lib/build";
export { lintExtension } from "./lib/lint";
export { packExtension, verifyPackage, collectPackageFiles, signFiles } from "./lib/amx";
export { runDev } from "./commands/dev";
export { DevClient, defaultDevSocketPath } from "./lib/dev-client";
export { resolveToken } from "./commands/publish";
export type { IO } from "./lib/io";

const COMMANDS: Record<string, { run: (argv: string[], io: IO) => Promise<number>; help: string }> = {
  create: { run: create, help: "create <dir> [--id <id>] [--name <name>]   scaffold a new extension" },
  build: { run: build, help: "build [dir] [--dev]                        bundle src/index.ts(x) → dist/main.js" },
  lint: { run: lint, help: "lint [dir] [--strict] [--json]             validate manifest + permissions" },
  pack: { run: pack, help: "pack [dir] [--sign <key.pem>] [-o out]     create a deterministic .amx" },
  verify: { run: verifyCmd, help: "verify <file.amx> --pubkey <key>           check hashes + signature" },
  keygen: { run: keygen, help: "keygen <keyId> [--out dir]                 new Ed25519 signing key" },
  dev: { run: dev, help: "dev [dir] [--socket path]                  watch, rebuild, hot-reload in the app" },
  publish: { run: publish, help: "publish [dir] [--token t] [--file x.amx]   upload to the AbuseMan store" },
};

function usage(io: IO) {
  io.out("abx — AbuseMan extension CLI\n\nUsage: abx <command> [options]\n");
  for (const c of Object.values(COMMANDS)) io.out(`  abx ${c.help}`);
}

/** Run the CLI; returns the exit code. */
export async function run(argv: string[], io: IO = consoleIO): Promise<number> {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === "help" || cmd === "--help" || cmd === "-h") {
    usage(io);
    return cmd ? 0 : 2;
  }
  if (cmd === "--version" || cmd === "-v") {
    io.out("1.0.0");
    return 0;
  }
  const c = COMMANDS[cmd];
  if (!c) {
    io.err(`unknown command "${cmd}"`);
    usage(io);
    return 2;
  }
  try {
    return await c.run(rest, io);
  } catch (e) {
    if (e instanceof CliError) {
      io.err(color.red(e.message));
      return e.exitCode;
    }
    if (e instanceof TypeError && (e as { code?: string }).code?.startsWith("ERR_PARSE_ARGS")) {
      io.err(color.red(e.message));
      return 2;
    }
    io.err(color.red(e instanceof Error ? (e.stack ?? e.message) : String(e)));
    return 1;
  }
}
