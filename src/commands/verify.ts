import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { verifyPackage } from "../lib/amx";
import { resolvePublicKeys } from "../lib/crypto";
import { color, type IO } from "../lib/io";
import { CliError } from "../lib/manifest";

export async function verifyCmd(argv: string[], io: IO): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      pubkey: { type: "string" },
      "allow-unsigned": { type: "boolean", default: false },
      json: { type: "boolean", default: false },
    },
  });
  const file = positionals[0];
  if (!file) throw new CliError("usage: abx verify <file.amx> --pubkey <base64url | public-keys.json | key.pem>", 2);
  const lookupKey = values.pubkey ? resolvePublicKeys(values.pubkey) : undefined;
  const r = verifyPackage(new Uint8Array(readFileSync(file)), {
    ...(lookupKey ? { lookupKey } : {}),
    requireSignature: !values["allow-unsigned"],
  });
  if (!values.pubkey && r.signature) r.errors.push("package is signed but no --pubkey was given to check it");
  const ok = r.errors.length === 0;
  if (values.json) {
    io.out(JSON.stringify({ ok, manifest: r.manifest ? { id: r.manifest.id, version: r.manifest.version } : null, files: r.files.length, signature: r.signature ?? null, errors: r.errors }, null, 2));
  } else {
    for (const e of r.errors) io.err(`${color.red("✗")} ${e}`);
    if (ok) {
      io.out(`${color.green("✓")} ${r.manifest!.id}@${r.manifest!.version}: ${r.files.length} files OK${r.signature ? `, signature valid (${r.signature.keyId})` : ", unsigned"}`);
    }
  }
  return ok ? 0 : 1;
}
