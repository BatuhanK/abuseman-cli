import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync, zipSync } from "fflate";
import { AmxFilesJson, DevMethods, HOST_PROVIDED_MODULES, Manifest } from "@abuseman/schemas";
import { run, runDev, type IO } from "../src/index";

const work = mkdtempSync(join(tmpdir(), "abx-test-"));
afterAll(() => rmSync(work, { recursive: true, force: true }));
const keys = join(import.meta.dir, "../../../tooling/keys/dev");

function capture(): IO & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, out: (l) => stdout.push(l), err: (l) => stderr.push(l) };
}
async function abx(...argv: string[]) {
  const io = capture();
  const code = await run(argv, io);
  return { code, ...io };
}

const ext = join(work, "my-ext");

describe("create → build → lint → pack → verify", () => {
  test("create scaffolds a valid project", async () => {
    const r = await abx("create", ext, "--id", "com.example.my-ext", "--name", "My Ext");
    expect(r.code).toBe(0);
    for (const f of ["manifest.json", "package.json", "tsconfig.json", "src/index.tsx", "README.md", ".gitignore"]) {
      expect(existsSync(join(ext, f))).toBe(true);
    }
    const m = Manifest.parse(JSON.parse(readFileSync(join(ext, "manifest.json"), "utf8")));
    expect(m.id).toBe("com.example.my-ext");
    expect(m.contributes?.commands?.[0]?.id).toBe("my_ext.showInfo");
    const pkg = JSON.parse(readFileSync(join(ext, "package.json"), "utf8"));
    expect(pkg.dependencies).toEqual({ "@abuseman/api": "^1.0.0", "@abuseman/ui": "^1.0.0" });
    expect(readFileSync(join(ext, "src/index.tsx"), "utf8")).toContain('ctx.commands.register("my_ext.showInfo"');
    expect((await abx("create", ext)).code).toBe(1); // not empty
  });

  test("build keeps host-provided modules external and uses production JSX", async () => {
    const r = await abx("build", ext);
    expect(r.code).toBe(0);
    const js = readFileSync(join(ext, "dist/main.js"), "utf8");
    expect(js).toContain('from"@abuseman/api"');
    expect(js).toContain('from"react/jsx-runtime"');
    expect(js).not.toContain("jsxDEV");
    for (const mod of HOST_PROVIDED_MODULES) expect(js).not.toContain(`node_modules/${mod}`);
    expect(existsSync(join(ext, "dist/main.js.map"))).toBe(true);
  });

  test("lint passes on the template", async () => {
    const r = await abx("lint", ext, "--json");
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout.join("\n"))).toEqual({ ok: true, issues: [] });
  });

  let amx = "";
  test("pack is deterministic and signed", async () => {
    amx = join(work, "out.amx");
    const a = await abx("pack", ext, "--sign", join(keys, "store-dev-1.dev-private.pem"), "-o", amx);
    expect(a.code).toBe(0);
    const first = readFileSync(amx);
    const b = await abx("pack", ext, "--sign", join(keys, "store-dev-1.dev-private.pem"), "-o", amx, "--no-build");
    expect(b.code).toBe(0);
    expect(Buffer.compare(first, readFileSync(amx))).toBe(0);
    const entries = unzipSync(new Uint8Array(first));
    expect(Object.keys(entries)).toEqual(["README.md", "dist/main.js", "dist/main.js.map", "manifest.json", "META-INF/files.json", "META-INF/signature.json"]);
    const files = AmxFilesJson.parse(JSON.parse(new TextDecoder().decode(entries["META-INF/files.json"])));
    expect(files.map((f) => f.path)).toEqual(["README.md", "dist/main.js", "dist/main.js.map", "manifest.json"]);
    expect(JSON.parse(new TextDecoder().decode(entries["META-INF/signature.json"]))).toMatchObject({ alg: "ed25519", keyId: "store-dev-1" });
  });

  test("verify: valid with key map / raw key; invalid with wrong key, tampering or missing signature", async () => {
    expect((await abx("verify", amx, "--pubkey", join(keys, "public-keys.json"))).code).toBe(0);
    const pub = JSON.parse(readFileSync(join(keys, "public-keys.json"), "utf8"));
    expect((await abx("verify", amx, "--pubkey", pub["store-dev-1"])).code).toBe(0);
    const wrong = await abx("verify", amx, "--pubkey", pub["first-party-dev-1"]);
    expect(wrong.code).toBe(1);
    expect(wrong.stderr.join("\n")).toContain("INVALID");

    const entries = unzipSync(new Uint8Array(readFileSync(amx)));
    entries["dist/main.js"] = new TextEncoder().encode("evil()");
    const tampered = join(work, "tampered.amx");
    writeFileSync(tampered, zipSync(entries));
    const t = await abx("verify", tampered, "--pubkey", join(keys, "public-keys.json"));
    expect(t.code).toBe(1);
    expect(t.stderr.join("\n")).toContain("hash mismatch: dist/main.js");

    const extra = unzipSync(new Uint8Array(readFileSync(amx)));
    extra["sneaky.js"] = new TextEncoder().encode("x");
    writeFileSync(tampered, zipSync(extra));
    expect((await abx("verify", tampered, "--pubkey", join(keys, "public-keys.json"))).stderr.join("\n")).toContain("not listed in files.json: sneaky.js");

    const unsigned = join(work, "unsigned.amx");
    expect((await abx("pack", ext, "-o", unsigned, "--no-build")).code).toBe(0);
    expect((await abx("verify", unsigned, "--pubkey", join(keys, "public-keys.json"))).code).toBe(1);
    expect((await abx("verify", unsigned, "--allow-unsigned")).code).toBe(0);
  });
});

describe("lint permission sanity", () => {
  const dir = join(work, "lint-ext");
  test("detects missing permissions and undeclared contributions", async () => {
    await abx("create", dir, "--id", "com.example.lint");
    const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    m.permissions = ["ui", "tools", "secrets"];
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(m));
    writeFileSync(
      join(dir, "src/extra.ts"),
      `export function x(ctx: any) {
         ctx.commands.register("lint.undeclared", () => {});
         ctx.storage.set("a", 1);
         ctx.proxy.onResponse("status:500", (res: any) => res.abort());
         Bun.spawn(["ls"]);
       }`,
    );
    const r = await abx("lint", dir, "--json");
    expect(r.code).toBe(1);
    const { issues } = JSON.parse(r.stdout.join("\n")) as { issues: { level: string; message: string }[] };
    const errors = issues.filter((i) => i.level === "error").map((i) => i.message);
    expect(errors).toEqual(
      expect.arrayContaining([
        'proxy hooks requires the "flows:read" permission',
        'modifying hook results requires the "proxy:modify" permission',
        'ctx.storage / useStorage requires the "storage" permission',
        'spawning processes requires the "process:spawn" permission',
        'command "lint.undeclared" is registered in code but not declared in contributes.commands',
      ]),
    );
    const warnings = issues.filter((i) => i.level === "warning").map((i) => i.message);
    expect(warnings).toContain('permission "secrets" is declared but no usage was found (static scan)');
  });

  test("schema errors are reported with paths", async () => {
    const m = JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8"));
    m.id = "Bad ID";
    m.contributes.menus.toolbar = [{ command: "nope" }];
    writeFileSync(join(dir, "manifest.json"), JSON.stringify(m));
    const r = await abx("lint", dir);
    expect(r.code).toBe(1);
    expect(r.stderr.join("\n")).toContain("id: extension id must be reverse-DNS");
    expect(r.stderr.join("\n")).toContain('menu item references undeclared command "nope"');
  });
});

describe("keygen", () => {
  test("writes a PKCS#8 key and prints the raw public key", async () => {
    const r = await abx("keygen", "test-key-1", "--out", work);
    expect(r.code).toBe(0);
    const pem = readFileSync(join(work, "test-key-1.private.pem"), "utf8");
    expect(pem).toStartWith("-----BEGIN PRIVATE KEY-----");
    expect(r.stdout[0]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // the new key signs packages that verify with its printed public key
    const amx = join(work, "k.amx");
    expect((await abx("pack", ext, "--sign", join(work, "test-key-1.private.pem"), "-o", amx, "--no-build")).code).toBe(0);
    expect((await abx("verify", amx, "--pubkey", r.stdout[0]!)).code).toBe(0);
    expect((await abx("keygen", "test-key-1", "--out", work)).code).toBe(1); // no overwrite
  });
});

describe("dev", () => {
  test("loads unpacked over the dev socket, then reloads on change", async () => {
    const sock = join(mkdtempSync(join(tmpdir(), "abxd-")), "dev.sock");
    const received: { method: string; params: any; id: string }[] = [];
    const server = Bun.listen({
      unix: sock,
      socket: {
        data(s, d) {
          for (const line of new TextDecoder().decode(d).split("\n").filter(Boolean)) {
            const msg = JSON.parse(line);
            received.push(msg);
            const spec = (DevMethods as any)[msg.method];
            spec.params.parse(msg.params);
            const result = msg.method === "dev.loadUnpacked" ? { ok: true, extensionId: "com.example.my-ext" } : { ok: true };
            spec.result.parse(result);
            s.write(`${JSON.stringify({ jsonrpc: "2.0", id: msg.id, result })}\n`);
          }
        },
      },
    });
    const ac = new AbortController();
    const io = capture();
    const done = runDev({ dir: ext, socketPath: sock, io, signal: ac.signal, debounceMs: 20 });
    const until = async (pred: () => boolean) => {
      for (let i = 0; i < 300 && !pred(); i++) await Bun.sleep(10);
      expect(pred()).toBe(true);
    };
    await until(() => received.length === 1);
    expect(received[0]).toMatchObject({ jsonrpc: "2.0", id: "d:1", method: "dev.loadUnpacked", params: { path: ext } });
    await Bun.sleep(100);
    const src = join(ext, "src/index.tsx");
    writeFileSync(src, readFileSync(src, "utf8") + "\n// touched\n");
    await until(() => received.length === 2);
    expect(received[1]).toMatchObject({ id: "d:2", method: "dev.reload", params: { extensionId: "com.example.my-ext" } });
    ac.abort();
    await done;
    server.stop(true);
    expect(io.stdout.some((l) => l.includes("reloaded com.example.my-ext"))).toBe(true);
  });

  test("warns (and keeps going) when the app is not running", async () => {
    const ac = new AbortController();
    const io = capture();
    const done = runDev({ dir: ext, socketPath: join(work, "missing.sock"), io, signal: ac.signal });
    for (let i = 0; i < 200 && !io.stderr.length; i++) await Bun.sleep(10);
    ac.abort();
    await done;
    expect(io.stderr.join("\n")).toContain("dev socket unavailable");
  });
});

describe("publish", () => {
  test("uploads multipart with bearer token to /api/dev/extensions/:id/versions", async () => {
    let seen: { path: string; auth: string | null; name?: string; size?: number } | undefined;
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const form = await req.formData();
        const file = form.get("file") as File;
        seen = { path: new URL(req.url).pathname, auth: req.headers.get("authorization"), name: file.name, size: file.size };
        return Response.json({ versionId: "ver_42", status: "pending" });
      },
    });
    const r = await abx("publish", ext, "--token", "amx_test", "--api", `http://127.0.0.1:${server.port}`);
    expect(r.code).toBe(0);
    expect(seen).toMatchObject({ path: "/api/dev/extensions/com.example.my-ext/versions", auth: "Bearer amx_test", name: "package.amx" });
    expect(r.stdout.join("\n")).toContain("ver_42");

    process.env.ABX_TOKEN = "amx_env";
    process.env.ABX_API_URL = `http://127.0.0.1:${server.port}`;
    const amx = join(work, "out.amx");
    expect((await abx("publish", "--file", amx)).code).toBe(0);
    expect(seen!.auth).toBe("Bearer amx_env");
    delete process.env.ABX_TOKEN;
    delete process.env.ABX_API_URL;
    server.stop(true);
  });

  test("reports API errors", async () => {
    const server = Bun.serve({ port: 0, fetch: () => Response.json({ error: "unauthorized", message: "bad token" }, { status: 401 }) });
    const r = await abx("publish", "--file", join(work, "out.amx"), "--token", "x", "--api", `http://127.0.0.1:${server.port}`);
    expect(r.code).toBe(1);
    expect(r.stderr.join("\n")).toContain("HTTP 401): unauthorized: bad token");
    server.stop(true);
  });
});
