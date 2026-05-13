import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { homedir } from "os";

export interface InboundForkHandlersConfig {
  /** Route inbound intercom messages to background fork handlers (default: false) */
  enabled: boolean;

  /** When to fork: only while parent is busy, or for all inbound messages */
  when: "busy" | "always";

  /** Parent notification policy for launched handlers */
  notify: "ack-and-summary" | "summary" | "none";

  /** Optional Pi executable override for handler launch */
  piCommand?: string;

  /** Trigger a parent turn when the handler summary arrives (default: false) */
  triggerParentOnSummary: boolean;
}

export interface IntercomConfig {
  /** Broker command used to spawn the broker process (e.g. "npx" or "bun") */
  brokerCommand: string;

  /** Arguments passed to the broker command before the broker script path */
  brokerArgs: string[];

  /** Require confirmation before non-reply sends from interactive sessions */
  confirmSend: boolean;

  /** Optional custom status suffix shown after automatic lifecycle status */
  status?: string;
  
  /** Enable/disable intercom (default: true) */
  enabled: boolean;
  
  /** Show reply hint in incoming messages (default: true) */
  replyHint: boolean;

  /** Optional inbound background fork-handler routing */
  inboundForkHandlers: InboundForkHandlersConfig;
}

const CONFIG_PATH = join(homedir(), ".pi/agent/intercom/config.json");

const defaults: IntercomConfig = {
  brokerCommand: "npx",
  brokerArgs: ["--no-install", "tsx"],
  confirmSend: false,
  enabled: true,
  replyHint: true,
  inboundForkHandlers: {
    enabled: false,
    when: "busy",
    notify: "ack-and-summary",
    triggerParentOnSummary: false,
  },
};

export function loadConfig(): IntercomConfig {
  if (!existsSync(CONFIG_PATH)) {
    return { ...defaults };
  }
  
  try {
    const raw = readFileSync(CONFIG_PATH, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("Config must be a JSON object");
    }

    const parsedConfig = parsed as Record<string, unknown>;
    const config: IntercomConfig = { ...defaults };

    if (Object.hasOwn(parsedConfig, "brokerCommand")) {
      if (typeof parsedConfig.brokerCommand !== "string") {
        throw new Error(`"brokerCommand" must be a string`);
      }
      const brokerCommand = parsedConfig.brokerCommand.trim();
      if (!brokerCommand) {
        throw new Error(`"brokerCommand" must not be empty`);
      }
      config.brokerCommand = brokerCommand;
    }

    if (Object.hasOwn(parsedConfig, "brokerArgs")) {
      if (!Array.isArray(parsedConfig.brokerArgs)) {
        throw new Error(`"brokerArgs" must be an array`);
      }
      const brokerArgs: string[] = [];
      for (const arg of parsedConfig.brokerArgs) {
        if (typeof arg !== "string") {
          throw new Error(`"brokerArgs" items must be strings`);
        }
        brokerArgs.push(arg);
      }
      config.brokerArgs = brokerArgs;
    }

    if (Object.hasOwn(parsedConfig, "confirmSend")) {
      if (typeof parsedConfig.confirmSend !== "boolean") {
        throw new Error(`"confirmSend" must be a boolean`);
      }
      config.confirmSend = parsedConfig.confirmSend;
    }

    if (Object.hasOwn(parsedConfig, "enabled")) {
      if (typeof parsedConfig.enabled !== "boolean") {
        throw new Error(`"enabled" must be a boolean`);
      }
      config.enabled = parsedConfig.enabled;
    }

    if (Object.hasOwn(parsedConfig, "replyHint")) {
      if (typeof parsedConfig.replyHint !== "boolean") {
        throw new Error(`"replyHint" must be a boolean`);
      }
      config.replyHint = parsedConfig.replyHint;
    }

    if (Object.hasOwn(parsedConfig, "status")) {
      if (typeof parsedConfig.status !== "string") {
        throw new Error(`"status" must be a string`);
      }
      config.status = parsedConfig.status;
    }

    if (Object.hasOwn(parsedConfig, "inboundForkHandlers")) {
      if (typeof parsedConfig.inboundForkHandlers !== "object" || parsedConfig.inboundForkHandlers === null || Array.isArray(parsedConfig.inboundForkHandlers)) {
        throw new Error(`"inboundForkHandlers" must be an object`);
      }
      const forkConfig = parsedConfig.inboundForkHandlers as Record<string, unknown>;
      config.inboundForkHandlers = { ...defaults.inboundForkHandlers };
      if (Object.hasOwn(forkConfig, "enabled")) {
        if (typeof forkConfig.enabled !== "boolean") throw new Error(`"inboundForkHandlers.enabled" must be a boolean`);
        config.inboundForkHandlers.enabled = forkConfig.enabled;
      }
      if (Object.hasOwn(forkConfig, "when")) {
        if (forkConfig.when !== "busy" && forkConfig.when !== "always") throw new Error(`"inboundForkHandlers.when" must be "busy" or "always"`);
        config.inboundForkHandlers.when = forkConfig.when;
      }
      if (Object.hasOwn(forkConfig, "notify")) {
        if (forkConfig.notify !== "ack-and-summary" && forkConfig.notify !== "summary" && forkConfig.notify !== "none") throw new Error(`"inboundForkHandlers.notify" must be "ack-and-summary", "summary", or "none"`);
        config.inboundForkHandlers.notify = forkConfig.notify;
      }
      if (Object.hasOwn(forkConfig, "piCommand")) {
        if (typeof forkConfig.piCommand !== "string") throw new Error(`"inboundForkHandlers.piCommand" must be a string`);
        const piCommand = forkConfig.piCommand.trim();
        if (piCommand) config.inboundForkHandlers.piCommand = piCommand;
      }
      if (Object.hasOwn(forkConfig, "triggerParentOnSummary")) {
        if (typeof forkConfig.triggerParentOnSummary !== "boolean") throw new Error(`"inboundForkHandlers.triggerParentOnSummary" must be a boolean`);
        config.inboundForkHandlers.triggerParentOnSummary = forkConfig.triggerParentOnSummary;
      }
    }

    return config;
  } catch (error) {
    console.error(`Failed to load intercom config at ${CONFIG_PATH}:`, error);
    return { ...defaults };
  }
}
