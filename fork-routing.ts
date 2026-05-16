import type { SessionInfo } from "./types.ts";

export const INTERCOM_FORK_HANDLER_STATUS_TAG = "fork-handler";

export type ForkHandlerKind = "intercom" | "return-on" | "subagent";

export interface ForkHandlerIdentity {
  kind: ForkHandlerKind;
  runId?: string;
  statusTag: string;
  sessionName: string;
}

function shortRunId(runId: string | undefined): string {
  const cleaned = runId?.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "") ?? "";
  const withoutPrefix = cleaned.replace(/^(?:icfh|roh|sbf)-?/i, "");
  const parts = withoutPrefix.split("-").filter(Boolean);
  const compact = parts.length >= 2 ? parts.slice(0, 2).join("-") : withoutPrefix;
  return (compact || "handler").slice(0, 24);
}

export function getForkHandlerIdentity(env: NodeJS.ProcessEnv = process.env): ForkHandlerIdentity | undefined {
  const candidates: Array<{ kind: ForkHandlerKind; flag: string | undefined; runId: string | undefined }> = [
    { kind: "intercom", flag: env.PI_INTERCOM_FORK_HANDLER, runId: env.PI_INTERCOM_FORK_HANDLER_RUN_ID },
    { kind: "return-on", flag: env.PI_RETURN_ON_HANDLER, runId: env.PI_RETURN_ON_HANDLER_RUN_ID },
    { kind: "subagent", flag: env.PI_SUBAGENT_BACKGROUND_HANDLER, runId: env.PI_SUBAGENT_BACKGROUND_HANDLER_RUN_ID },
  ];
  const match = candidates.find((candidate) => candidate.flag === "1");
  if (!match) return undefined;
  const runId = match.runId?.trim() || undefined;
  const statusTag = runId ? `${INTERCOM_FORK_HANDLER_STATUS_TAG}:${match.kind}:${runId}` : `${INTERCOM_FORK_HANDLER_STATUS_TAG}:${match.kind}`;
  return {
    kind: match.kind,
    ...(runId ? { runId } : {}),
    statusTag,
    sessionName: `fork-${match.kind}-${shortRunId(runId)}`,
  };
}

export function buildIntercomStatus(lifecycleStatus: string, customStatus?: string, env: NodeJS.ProcessEnv = process.env): string {
  const suffixes: string[] = [];
  const trimmedCustomStatus = customStatus?.trim();
  if (trimmedCustomStatus) suffixes.push(trimmedCustomStatus);
  const forkHandler = getForkHandlerIdentity(env);
  if (forkHandler) suffixes.push(forkHandler.statusTag);
  return suffixes.length ? `${lifecycleStatus} · ${suffixes.join(" · ")}` : lifecycleStatus;
}

export function isForkHandlerSession(session: Pick<SessionInfo, "status">): boolean {
  const status = session.status?.toLowerCase() ?? "";
  return /(?:^|[\s·])fork-handler(?::|$|[\s·])/.test(status);
}
