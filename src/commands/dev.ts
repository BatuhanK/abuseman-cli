import { watch, readFileSync, existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { buildExtension } from "../lib/build";
import { DevClient, defaultDevSocketPath } from "../lib/dev-client";
import { color, type IO } from "../lib/io";
import { lintExtension } from "../lib/lint";

export interface DevOptions {
  dir: string;
  socketPath: string;
  io: IO;
  signal?: AbortSignal;
  debounceMs?: number;
}

const WATCHED = /^(src|assets)([\\/]|$)|^manifest\.json$|^README\.md$|^icon\.png$/;

/**
 * Watch + rebuild + hot reload (CONTRACTS §13). Resolves when `signal` aborts.
 */
export async function runDev(opts: DevOptions): Promise<void> {
  const { dir, socketPath, io } = opts;
  let client: DevClient | undefined;
  let extensionId: string | undefined;
  let loadedManifest = "";
  let warnedOffline = false;

  const manifestText = () => (existsSync(join(dir, "manifest.json")) ? readFileSync(join(dir, "manifest.json"), "utf8") : "");

  async function notifyApp() {
    const text = manifestText();
    try {
      if (!client || client.closed) {
        client = await DevClient.connect(socketPath);
        extensionId = undefined;
        warnedOffline = false;
      }
      if (!extensionId || text !== loadedManifest) {
        const r = await client.request("dev.loadUnpacked", { path: dir });
        extensionId = r.extensionId ?? (JSON.parse(text) as { id: string }).id;
        loadedManifest = text;
        io.out(`${color.green("●")} loaded ${extensionId} into AbuseMan`);
      } else {
        await client.request("dev.reload", { extensionId });
        io.out(`${color.green("↻")} reloaded ${extensionId}`);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (client?.closed !== false || /ENOENT|ECONNREFUSED|closed|connect/i.test(msg)) {
        client = undefined;
        if (!warnedOffline) {
          io.err(color.yellow(`AbuseMan dev socket unavailable (${socketPath}): start AbuseMan and turn on Settings › Extensions › Developer mode. Retrying after the next build.`));
          warnedOffline = true;
        }
      } else io.err(color.red(`app rejected the extension: ${msg}`));
    }
  }

  let building = false;
  let again = false;
  async function cycle() {
    if (building) {
      again = true;
      return;
    }
    building = true;
    do {
      again = false;
      try {
        const r = await buildExtension(dir, { dev: true });
        io.out(`${color.dim(new Date().toLocaleTimeString())} built ${r.manifest.id} (${(r.bytes / 1024).toFixed(1)} KiB, ${r.durationMs} ms)`);
        for (const i of lintExtension(dir).issues.filter((x) => x.level === "error")) io.err(color.red(`lint: ${i.message}`));
        await notifyApp();
      } catch (e) {
        io.err(color.red(e instanceof Error ? e.message : String(e)));
      }
    } while (again);
    building = false;
  }

  await cycle();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watcher = watch(dir, { recursive: true }, (_event, filename) => {
    if (!filename) return;
    const rel = filename.toString().split(sep).join("/");
    if (!WATCHED.test(rel)) return;
    clearTimeout(timer);
    timer = setTimeout(() => void cycle(), opts.debounceMs ?? 120);
  });
  io.out(color.dim(`watching ${dir} — Ctrl+C to stop`));
  await new Promise<void>((res) => {
    if (opts.signal?.aborted) return res();
    opts.signal?.addEventListener("abort", () => res(), { once: true });
  });
  clearTimeout(timer);
  watcher.close();
  client?.close();
}

export async function dev(argv: string[], io: IO): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { socket: { type: "string" } },
  });
  const ac = new AbortController();
  process.once("SIGINT", () => ac.abort());
  process.once("SIGTERM", () => ac.abort());
  await runDev({ dir: resolve(positionals[0] ?? "."), socketPath: values.socket ?? defaultDevSocketPath(), io, signal: ac.signal });
  return 0;
}
