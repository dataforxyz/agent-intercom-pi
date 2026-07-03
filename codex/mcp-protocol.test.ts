import test from "node:test";
import assert from "node:assert/strict";
import { handleMcpRequest } from "./mcp-protocol.ts";

function fakeRuntime() {
  return {
    whoami: async () => ({ content: [{ type: "text" as const, text: "me" }], structuredContent: { session_id: "s1" } }),
    status: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
    list: async () => ({ content: [{ type: "text" as const, text: "sessions" }], structuredContent: { sessions: [] } }),
    setSummary: async (summary: string) => ({ content: [{ type: "text" as const, text: `summary:${summary}` }] }),
    send: async (to: string, message: string) => ({ content: [{ type: "text" as const, text: `send:${to}:${message}` }] }),
    ask: async (to: string, message: string) => ({ content: [{ type: "text" as const, text: `ask:${to}:${message}` }] }),
    pending: async () => ({ content: [{ type: "text" as const, text: "pending" }] }),
    reply: async (message: string) => ({ content: [{ type: "text" as const, text: `reply:${message}` }] }),
  } as any;
}

test("initialize returns MCP capabilities", async () => {
  const response = await handleMcpRequest({ id: 1, method: "initialize" }, fakeRuntime());

  assert.equal(response?.jsonrpc, "2.0");
  assert.deepEqual((response?.result as any).capabilities, { tools: {} });
});

test("tools/list includes intercom tools", async () => {
  const response = await handleMcpRequest({ id: 2, method: "tools/list" }, fakeRuntime());
  const tools = (response?.result as any).tools as Array<{ name: string }>;

  assert.ok(tools.some((tool) => tool.name === "intercom_list"));
  assert.ok(tools.some((tool) => tool.name === "intercom_ask"));
  assert.ok(tools.some((tool) => tool.name === "intercom_reply"));
});

test("tools/call dispatches to the selected tool", async () => {
  const response = await handleMcpRequest({
    id: 3,
    method: "tools/call",
    params: {
      name: "intercom_send",
      arguments: { to: "worker", message: "hello" },
    },
  }, fakeRuntime());

  assert.equal(((response?.result as any).content[0]).text, "send:worker:hello");
});

test("tools/call reports validation errors as tool errors", async () => {
  const response = await handleMcpRequest({
    id: 4,
    method: "tools/call",
    params: {
      name: "intercom_send",
      arguments: { to: "worker" },
    },
  }, fakeRuntime());

  assert.equal((response?.result as any).isError, true);
  assert.match(((response?.result as any).content[0]).text, /message must be/);
});

test("notifications do not receive responses", async () => {
  const response = await handleMcpRequest({ method: "notifications/initialized" }, fakeRuntime());

  assert.equal(response, undefined);
});
