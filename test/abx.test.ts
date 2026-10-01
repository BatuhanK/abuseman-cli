import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync, zipSync } from "fflate";
import { AmxFilesJson, DevMethods, HOST_PROVIDED_MODULES, Manifest } from "@abuseman/schemas";
import { run, runDev, type IO } from "../src/index";
import { lintExtension, mapSource } from "../src/lib/lint";

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

describe("lint static scan: false positives", () => {
  let n = 0;
  /** A minimal extension on disk: manifest overrides + one source file. */
  function mk(manifest: Record<string, unknown>, source: string): string {
    const dir = join(work, `lint-fp-${++n}`);
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(
      join(dir, "manifest.json"),
      JSON.stringify({ id: `com.example.fp${n}`, name: "FP", version: "1.0.0", engines: { abuseman: "^1.0.0" }, main: "dist/main.js", permissions: ["ui"], ...manifest }),
    );
    writeFileSync(join(dir, "src/index.ts"), source);
    return dir;
  }
  const msgs = (dir: string, level: "error" | "warning") =>
    lintExtension(dir).issues.filter((i) => i.level === level).map((i) => i.message);
  const cmds = (...ids: string[]) => ({ contributes: { commands: ids.map((id) => ({ id, title: id })) } });

  describe("command ids", () => {
    test("template-literal ids in a loop: no error, and no 'never registered' warning", () => {
      const dir = mk(
        cmds("x.a", "x.b"),
        "export default (ctx: any) => { for (const id of ['a', 'b']) ctx.commands.register(`x.${id}`, () => {}); };",
      );
      expect(msgs(dir, "error")).toEqual([]);
      expect(msgs(dir, "warning").filter((m) => m.includes("never registered"))).toEqual([]);
    });

    test("variables and concatenation count as non-literal too", () => {
      const dir = mk(
        cmds("x.a", "x.b"),
        "export default (ctx: any, id: string) => { ctx.commands.register(id, () => {}); ctx.commands.register('x.' + id, () => {}); };",
      );
      expect(msgs(dir, "error")).toEqual([]);
      expect(msgs(dir, "warning").filter((m) => m.includes("never registered"))).toEqual([]);
    });

    test("string-literal ids are still checked (undeclared → error, unregistered → warning)", () => {
      const dir = mk(cmds("x.declared", "x.unused"), "export default (ctx: any) => { ctx.commands.register('x.declared', () => {}); ctx.commands.register(\"x.other\", () => {}); };");
      expect(msgs(dir, "error")).toEqual(['command "x.other" is registered in code but not declared in contributes.commands']);
      expect(msgs(dir, "warning")).toContain('command "x.unused" is declared but never registered (static scan)');
    });

    test("a literal id next to a dynamic one is still validated, but declared ids are not reported missing", () => {
      const dir = mk(
        cmds("x.a", "x.b"),
        "export default (ctx: any) => { ctx.commands.register('x.typo', () => {}); for (const i of [1]) ctx.commands.register(`x.${i}`, () => {}); };",
      );
      expect(msgs(dir, "error")).toEqual(['command "x.typo" is registered in code but not declared in contributes.commands']);
      expect(msgs(dir, "warning").filter((m) => m.includes("never registered"))).toEqual([]);
    });

    test("registrations in comments and strings are ignored", () => {
      const dir = mk(cmds("x.a"), "// ctx.commands.register('x.ghost', f)\nconst s = \"ctx.commands.register('x.ghost2', f)\";\nexport default (ctx: any) => ctx.commands.register('x.a', () => {});");
      expect(msgs(dir, "error")).toEqual([]);
    });

    test("dynamic view ids silence 'no component registered'", () => {
      const dir = mk(
        { contributes: { sidebarSections: [{ id: "v.a", title: "A" }, { id: "v.b", title: "B" }] } },
        "export default (ctx: any) => { for (const id of ['a', 'b']) ctx.ui.registerView(`v.${id}`, () => null); };",
      );
      expect(msgs(dir, "warning").filter((m) => m.includes("no component is registered"))).toEqual([]);
    });
  });

  describe("fetch egress warning", () => {
    const egress = (dir: string) => msgs(dir, "warning").some((m) => m.startsWith("fetch() is used"));
    test("a real fetch call warns when network is empty", () => {
      expect(egress(mk({}, "export async function f() { return await fetch('https://a.com'); }"))).toBe(true);
      expect(egress(mk({}, "export const g = () => Bun.$ && (globalThis as any).net.fetch('https://a.com');"))).toBe(true);
    });
    test("not when network is declared", () => {
      expect(egress(mk({ network: ["a.com"] }, "export async function f() { return fetch('https://a.com'); }"))).toBe(false);
    });
    test("fetch( inside strings, templates and comments is ignored (code generators)", () => {
      const src = [
        "// fetch('https://a.com')",
        "/* await fetch(url) */",
        "export const a = \"fetch(url)\";",
        "export const b = 'it\\'s fetch(url)';",
        "export const c = `const r = await fetch(${JSON.stringify('x')});\nfetch('y')`;",
        "export const d = `outer ${`inner fetch(z)`} fetch(w)`;",
        "export const e = /fetch\\(/.test('x');",
      ].join("\n");
      expect(egress(mk({}, src))).toBe(false);
    });
    test("a real call inside a template's ${…} expression still counts", () => {
      expect(egress(mk({}, "export const a = async () => `${await fetch('https://a.com')}`;"))).toBe(true);
    });
    test("code after a string / template containing fetch( is still scanned", () => {
      expect(egress(mk({}, "const s = `fetch(x)`;\nexport const go = () => fetch('https://a.com');"))).toBe(true);
    });
  });

  describe("proxy:modify without flows:read", () => {
    const warned = (dir: string) => msgs(dir, "warning").some((m) => m.includes('"proxy:modify" without "flows:read"'));
    test("ctx.rules only: no warning", () => {
      const dir = mk({ permissions: ["ui", "proxy:modify"] }, "export default async (ctx: any) => { await ctx.rules.create({ name: 'x', match: 'host:a.com', action: { type: 'block' } }); ctx.ui.toast('ok'); };");
      expect(warned(dir)).toBe(false);
      expect(msgs(dir, "error")).toEqual([]);
    });
    test("rules.list / rules.update / ui.revealFlow are recognised permission usage", () => {
      const dir = mk({ permissions: ["proxy:modify", "ui"] }, "export default async (ctx: any) => { await ctx.rules.list(); await ctx.rules.update({ id: 'a' }); await ctx.ui.revealFlow('f'); };");
      expect(msgs(dir, "error")).toEqual([]);
      expect(msgs(dir, "warning").filter((m) => m.includes("declared but no usage"))).toEqual([]);
      const noPerm = mk({ permissions: [] }, "export default async (ctx: any) => { await ctx.rules.list(); await ctx.ui.revealFlow('f'); };");
      expect(msgs(noPerm, "error")).toEqual(['ctx.rules requires the "proxy:modify" permission', 'ctx.ui requires the "ui" permission']);
    });
    test("proxy hooks without flows:read: warns", () => {
      const dir = mk({ permissions: ["ui", "proxy:modify"] }, "export default (ctx: any) => { ctx.proxy.onRequest('host:a.com', (r: any) => r.headers.set('x', '1')); };");
      expect(warned(dir)).toBe(true);
    });
    test("proxy hooks with flows:read: no warning", () => {
      const dir = mk({ permissions: ["ui", "proxy:modify", "flows:read"] }, "export default (ctx: any) => { ctx.proxy.onRequest('host:a.com', (r: any) => r.headers.set('x', '1')); ctx.ui.toast('x'); };");
      expect(warned(dir)).toBe(false);
    });
  });

  describe("mapSource lexer", () => {
    const codeOf = (src: string) => {
      const m = mapSource(src);
      return [...src].map((c, i) => (m.inCode[i] ? c : " ")).join("");
    };
    test("blanks comments, strings, regexes; keeps template expressions", () => {
      expect(codeOf("a('x') // b\n/* c */ d")).toBe("a(   )     \n        d");
      expect(codeOf("`a${b(`c`)}d`")).toBe("    b(   )   ");
      expect(codeOf("x = /a[/]b/g; y")).toBe("x =         ; y");
      expect(codeOf("a / b / c")).toBe("a / b / c");
    });
    test("never throws on unterminated input", () => {
      for (const src of ["'abc", "`abc ${", "/* open", "x = /re", "`${`${`", "\\"]) expect(() => mapSource(src)).not.toThrow();
    });
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
