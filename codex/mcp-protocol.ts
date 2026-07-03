import type { CodexIntercomRuntime, ToolResult } from "./runtime.ts";

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: ToolHandler;
}

function asString(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value;
}

function asBoolean(value: unknown, defaultValue: boolean): boolean {
  return typeof value === "boolean" ? value : defaultValue;
}

function asAttachmentArray(value: unknown) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new Error("attachments must be an array");
  return value.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error(`attachments[${index}] must be an object`);
    const raw = item as Record<string, unknown>;
    const type = raw.type;
    if (type !== "file" && type !== "snippet" && type !== "context") throw new Error(`attachments[${index}].type must be file, snippet, or context`);
    const name = asString(raw.name, `attachments[${index}].name`);
    const content = asString(raw.content, `attachments[${index}].content`);
    if (raw.language !== undefined && typeof raw.language !== "string") throw new Error(`attachments[${index}].language must be a string`);
    return { type, name, content, ...(raw.language ? { language: raw.language } : {}) };
  });
}

const attachmentsSchema = {
  type: "array",
  items: {
    type: "object",
    properties: {
      type: { type: "string", enum: ["file", "snippet", "context"] },
      name: { type: "string" },
      content: { type: "string" },
      language: { type: "string" },
    },
    required: ["type", "name", "content"],
    additionalProperties: false,
  },
};

export function buildToolDefinitions(runtime: CodexIntercomRuntime): ToolDefinition[] {
  return [
    {
      name: "intercom_whoami",
      description: "Return this Codex session's intercom identity for reliable targeting.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      handler: async () => runtime.whoami(),
    },
    {
      name: "intercom_status",
      description: "Show intercom connection status, active sessions, unread messages, and pending asks.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      handler: async () => runtime.status(),
    },
    {
      name: "intercom_list",
      description: "List intercom-connected Pi or Codex sessions on this machine.",
      inputSchema: {
        type: "object",
        properties: {
          scope: { type: "string", enum: ["machine", "directory", "repo"], default: "machine" },
          include_self: { type: "boolean", default: false },
        },
        additionalProperties: false,
      },
      handler: async (args) => runtime.list(
        args.scope === "directory" || args.scope === "repo" ? args.scope : "machine",
        asBoolean(args.include_self, false),
      ),
    },
    {
      name: "intercom_set_summary",
      description: "Publish a short status summary so other sessions can discover what this Codex session is doing.",
      inputSchema: {
        type: "object",
        properties: { summary: { type: "string", maxLength: 400 } },
        required: ["summary"],
        additionalProperties: false,
      },
      handler: async (args) => runtime.setSummary(asString(args.summary, "summary")),
    },
    {
      name: "intercom_send",
      description: "Send a non-blocking direct message to another intercom session by name, full ID, or unique ID prefix.",
      inputSchema: {
        type: "object",
        properties: {
          to: { type: "string" },
          message: { type: "string" },
          attachments: attachmentsSchema,
        },
        required: ["to", "message"],
        additionalProperties: false,
      },
      handler: async (args) => runtime.send(asString(args.to, "to"), asString(args.message, "message"), asAttachmentArray(args.attachments)),
    },
    {
      name: "intercom_ask",
      description: "Ask another intercom session a question and wait for its reply.",
      inputSchema: {
        type: "object",
        properties: {
          to: { type: "string" },
          message: { type: "string" },
          attachments: attachmentsSchema,
        },
        required: ["to", "message"],
        additionalProperties: false,
      },
      handler: async (args) => runtime.ask(asString(args.to, "to"), asString(args.message, "message"), asAttachmentArray(args.attachments)),
    },
    {
      name: "intercom_pending",
      description: "Read unread inbound messages and unresolved asks for this Codex session.",
      inputSchema: {
        type: "object",
        properties: { mark_read: { type: "boolean", default: false } },
        additionalProperties: false,
      },
      handler: async (args) => runtime.pending(asBoolean(args.mark_read, false)),
    },
    {
      name: "intercom_reply",
      description: "Reply to a pending inbound ask. If exactly one ask is pending, to/reply_to can be omitted.",
      inputSchema: {
        type: "object",
        properties: {
          message: { type: "string" },
          to: { type: "string" },
          reply_to: { type: "string" },
        },
        required: ["message"],
        additionalProperties: false,
      },
      handler: async (args) => runtime.reply(asString(args.message, "message"), typeof args.to === "string" ? args.to : undefined, typeof args.reply_to === "string" ? args.reply_to : undefined),
    },
  ];
}

function ok(id: JsonRpcRequest["id"], result: unknown) {
  return { jsonrpc: "2.0", id, result };
}

function error(id: JsonRpcRequest["id"], code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

export async function handleMcpRequest(request: JsonRpcRequest, runtime: CodexIntercomRuntime): Promise<Record<string, unknown> | undefined> {
  if (!request.method) {
    return error(request.id, -32600, "Invalid request");
  }

  if (request.id === undefined && request.method.startsWith("notifications/")) {
    return undefined;
  }

  const tools = buildToolDefinitions(runtime);
  switch (request.method) {
    case "initialize":
      return ok(request.id, {
        protocolVersion: "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "pi-intercom", version: "0.6.0" },
      });
    case "ping":
      return ok(request.id, {});
    case "tools/list":
      return ok(request.id, {
        tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      });
    case "tools/call": {
      const name = request.params?.name;
      const args = request.params?.arguments;
      if (typeof name !== "string") return error(request.id, -32602, "tools/call requires params.name");
      if (args !== undefined && (!args || typeof args !== "object" || Array.isArray(args))) {
        return error(request.id, -32602, "tools/call params.arguments must be an object");
      }
      const tool = tools.find((candidate) => candidate.name === name);
      if (!tool) return error(request.id, -32602, `Unknown tool: ${name}`);
      try {
        return ok(request.id, await tool.handler((args ?? {}) as Record<string, unknown>));
      } catch (caught) {
        const message = caught instanceof Error ? caught.message : String(caught);
        return ok(request.id, { content: [{ type: "text", text: message }], isError: true });
      }
    }
    default:
      return error(request.id, -32601, `Method not found: ${request.method}`);
  }
}
