import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { CliError } from "./manifest";

export const sha256Hex = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");
export const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest();

/** Generate an Ed25519 keypair: PKCS#8 PEM private key + base64url raw 32-byte public key. */
export function generateEd25519(): { privatePem: string; publicRaw: string } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  return {
    privatePem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicRaw: publicKey.export({ format: "jwk" }).x!,
  };
}

export function loadPrivateKey(path: string): KeyObject {
  if (!existsSync(path)) throw new CliError(`private key not found: ${path}`);
  const key = createPrivateKey(readFileSync(path));
  if (key.asymmetricKeyType !== "ed25519") throw new CliError(`${path} is not an Ed25519 key`);
  return key;
}

/** Infer a key id from a key file name: `store-dev-1.dev-private.pem` → `store-dev-1`. */
export function keyIdFromPath(path: string): string {
  return basename(path).replace(/\.(dev-)?private\.pem$/, "").replace(/\.pem$/, "");
}

export function publicKeyFromRaw(raw: string): KeyObject {
  return createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: raw }, format: "jwk" });
}

export function rawFromPublicKey(key: KeyObject): string {
  return key.export({ format: "jwk" }).x!;
}

/**
 * Resolve `--pubkey` into a key lookup:
 * - a base64url raw key (any keyId),
 * - a JSON file `{ "<kid>": "<raw>" }` (e.g. tooling/keys/dev/public-keys.json),
 * - a PEM public or private key file.
 */
export function resolvePublicKeys(spec: string): (keyId: string) => KeyObject | undefined {
  if (existsSync(spec)) {
    const text = readFileSync(spec, "utf8");
    if (text.trimStart().startsWith("{")) {
      const map = JSON.parse(text) as Record<string, string>;
      return (kid) => (map[kid] ? publicKeyFromRaw(map[kid]!) : undefined);
    }
    const key = text.includes("PRIVATE KEY") ? createPublicKey(createPrivateKey(text)) : createPublicKey(text);
    return () => key;
  }
  if (/^[A-Za-z0-9_-]{43}$/.test(spec)) {
    const key = publicKeyFromRaw(spec);
    return () => key;
  }
  throw new CliError(`--pubkey must be a base64url Ed25519 public key or a path to a key / public-keys.json file`);
}

export const ed25519Sign = (message: Uint8Array, key: KeyObject) => sign(null, message, key);
export const ed25519Verify = (message: Uint8Array, key: KeyObject, signature: Uint8Array) => verify(null, message, key, signature);
