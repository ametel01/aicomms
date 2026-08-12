import type { McpServerLaunch } from "../../src/app-server.ts";

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

export class McpTestClient {
  readonly #child: ReturnType<typeof Bun.spawn<"pipe", "pipe", "pipe">>;
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #decoder = new TextDecoder();
  #buffer = "";
  #requestId = 0;

  private constructor(child: ReturnType<typeof Bun.spawn<"pipe", "pipe", "pipe">>) {
    this.#child = child;
    this.#reader = child.stdout.getReader();
  }

  static spawn(launch: McpServerLaunch): McpTestClient {
    const child = Bun.spawn([launch.command, ...launch.args], {
      env: { ...process.env, ...launch.env },
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    return new McpTestClient(child);
  }

  async initialize(): Promise<JsonRpcResponse> {
    return this.request("initialize", {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "discovery-test", version: "1.0.0" },
    });
  }

  async request(method: string, params: unknown = {}): Promise<JsonRpcResponse> {
    const id = ++this.#requestId;
    this.#child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    this.#child.stdin.flush();
    for (;;) {
      const newline = this.#buffer.indexOf("\n");
      if (newline !== -1) {
        const line = this.#buffer.slice(0, newline);
        this.#buffer = this.#buffer.slice(newline + 1);
        return JSON.parse(line) as JsonRpcResponse;
      }
      const chunk = await this.#reader.read();
      if (chunk.done) {
        throw new Error("MCP adapter exited before responding.");
      }
      this.#buffer += this.#decoder.decode(chunk.value, { stream: true });
    }
  }

  async close(): Promise<void> {
    this.#child.kill();
    await this.#child.exited;
  }
}
