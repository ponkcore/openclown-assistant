/**
 * Mock OpenAI-compatible HTTP server for provider-swap smoke tests.
 *
 * Boots a localhost-only `http.createServer` on an OS-assigned port
 * (`:0`) and returns the assigned port + base URL.  Handles the two
 * OpenAI-compatible surfaces the codebase uses:
 *
 *   POST /v1/chat/completions     →  OpenAI chat-completion JSON
 *   POST /v1/audio/transcriptions →  { text: voiceResponseText }
 *
 * Uses only Node's built-in `http` module — no extra deps per TKT-036@0.1.0 §7.
 */

import http from "node:http";

// ── Config & result types ───────────────────────────────────────────────────

export interface MockServerConfig {
  /** Text returned in `choices[0].message.content` for chat completions. */
  chatResponseText: string;
  /** Text returned in `text` field for audio transcriptions. */
  voiceResponseText: string;
  /** Optional model string in the chat-completion response (default "mock-model"). */
  model?: string;
}

export interface MockServer {
  /** Base URL including the `/v1` suffix, e.g. `http://127.0.0.1:43210/v1`. */
  baseUrl: string;
  /** OS-assigned port the server is listening on. */
  port: number;
  /** Gracefully shut down the server. Resolves when the server is closed. */
  close(): Promise<void>;
}

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * Start a mock OpenAI-compatible HTTP server on an OS-assigned port.
 *
 * The server responds synchronously (no I/O delay) which keeps smoke
 * tests fast.  It consumes the request body fully before responding so
 * that the client (Node `fetch`) doesn't hit a premature connection close.
 */
export function createMockServer(config: MockServerConfig): Promise<MockServer> {
  return new Promise((resolve, reject) => {
    const model = config.model ?? "mock-model";

    const server = http.createServer((req, res) => {
      // Consume entire body regardless of Content-Type so the
      // client-side `fetch` completes its side of the TCP stream.
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const url = req.url ?? "/";
        const method = req.method ?? "GET";

        if (method === "POST" && url === "/v1/chat/completions") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              choices: [{ message: { content: config.chatResponseText } }],
              usage: { prompt_tokens: 10, completion_tokens: 5 },
              model,
            }),
          );
        } else if (method === "POST" && url === "/v1/audio/transcriptions") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              text: config.voiceResponseText,
            }),
          );
        } else {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "not found" }));
        }
      });
    });

    server.on("error", reject);

    server.listen(0, () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        reject(new Error("Failed to get server address"));
        return;
      }
      const port = addr.port;
      resolve({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        port,
        close: () =>
          new Promise<void>((res, rej) => {
            server.close((err) => (err ? rej(err) : res()));
          }),
      });
    });
  });
}
