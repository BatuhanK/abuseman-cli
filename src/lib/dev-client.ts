/**
 * Minimal NDJSON JSON-RPC client for the app's dev socket (CONTRACTS §13).
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { DEV_SOCKET_RELATIVE_PATH, type DevMethodMap } from "@abuseman/schemas";

export function defaultDevSocketPath(): string {
  return process.env.ABUSEMAN_DEV_SOCKET ?? join(homedir(), "Library/Application Support/AbuseMan", DEV_SOCKET_RELATIVE_PATH);
}

export class DevRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

export class DevClient {
  #socket!: Awaited<ReturnType<typeof Bun.connect>>;
  #buffer = "";
  #counter = 0;
  #pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  #closed = false;

  private constructor() {}

  static async connect(path: string): Promise<DevClient> {
    const c = new DevClient();
    const decoder = new TextDecoder();
    c.#socket = await Bun.connect({
      unix: path,
      socket: {
        data: (_s, d) => {
          c.#buffer += decoder.decode(d, { stream: true });
          let nl: number;
          while ((nl = c.#buffer.indexOf("\n")) !== -1) {
            const line = c.#buffer.slice(0, nl);
            c.#buffer = c.#buffer.slice(nl + 1);
            if (line.trim()) c.#onLine(line);
          }
        },
        close: () => c.#fail("dev socket closed"),
        error: (_s, e) => c.#fail(String(e)),
      },
    });
    return c;
  }

  get closed(): boolean {
    return this.#closed;
  }

  #fail(reason: string) {
    this.#closed = true;
    for (const p of this.#pending.values()) p.reject(new Error(reason));
    this.#pending.clear();
  }

  #onLine(line: string) {
    let msg: any;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    const p = typeof msg?.id === "string" ? this.#pending.get(msg.id) : undefined;
    if (!p) return;
    this.#pending.delete(msg.id);
    if (msg.error) p.reject(new DevRpcError(msg.error.code ?? -32603, msg.error.message ?? "error"));
    else p.resolve(msg.result);
  }

  request<M extends keyof DevMethodMap>(method: M, params: DevMethodMap[M]["params"], timeoutMs = 30_000): Promise<DevMethodMap[M]["result"]> {
    if (this.#closed) return Promise.reject(new Error("dev socket closed"));
    const id = `d:${++this.#counter}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`${method} timed out`));
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
      this.#socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    });
  }

  close(): void {
    this.#closed = true;
    this.#socket.end();
  }
}
