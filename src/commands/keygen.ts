import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { generateEd25519 } from "../lib/crypto";
import type { IO } from "../lib/io";
import { CliError } from "../lib/manifest";

export async function keygen(argv: string[], io: IO): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { out: { type: "string", short: "o" }, force: { type: "boolean", default: false } },
  });
  const keyId = positionals[0];
  if (!keyId || !/^[A-Za-z0-9._-]+$/.test(keyId)) throw new CliError("usage: abx keygen <keyId> [--out dir]", 2);
  const dir = resolve(values.out ?? ".");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${keyId}.private.pem`);
  if (existsSync(path) && !values.force) throw new CliError(`${path} exists (use --force to overwrite)`);
  const { privatePem, publicRaw } = generateEd25519();
  writeFileSync(path, privatePem, { mode: 0o600 });
  io.err(`private key (PKCS#8 PEM): ${path}`);
  io.out(publicRaw);
  io.err(JSON.stringify({ [keyId]: publicRaw }));
  return 0;
}
