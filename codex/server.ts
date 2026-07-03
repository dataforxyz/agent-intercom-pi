import readline from "node:readline";
import { stdin, stdout } from "node:process";
import { CodexIntercomRuntime } from "./runtime.ts";
import { handleMcpRequest } from "./mcp-protocol.ts";

const runtime = new CodexIntercomRuntime();

const rl = readline.createInterface({
  input: stdin,
  crlfDelay: Infinity,
});

function writeResponse(response: Record<string, unknown> | undefined): void {
  if (!response) return;
  stdout.write(`${JSON.stringify(response)}\n`);
}

rl.on("line", (line) => {
  void (async () => {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const request = JSON.parse(trimmed);
      writeResponse(await handleMcpRequest(request, runtime));
    } catch (error) {
      writeResponse({
        jsonrpc: "2.0",
        id: null,
        error: {
          code: -32700,
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  })();
});

const shutdown = () => {
  void runtime.disconnect().finally(() => process.exit(0));
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
