import type { SessionInfo } from "./types.ts";

export const INTERCOM_FORK_HANDLER_STATUS_TAG = "fork-handler";

export function buildIntercomStatus(lifecycleStatus: string, customStatus?: string, env: NodeJS.ProcessEnv = process.env): string {
  const suffixes: string[] = [];
  const trimmedCustomStatus = customStatus?.trim();
  if (trimmedCustomStatus) suffixes.push(trimmedCustomStatus);
  if (env.PI_INTERCOM_FORK_HANDLER === "1") {
    const runId = env.PI_INTERCOM_FORK_HANDLER_RUN_ID?.trim();
    suffixes.push(runId ? `${INTERCOM_FORK_HANDLER_STATUS_TAG}:${runId}` : INTERCOM_FORK_HANDLER_STATUS_TAG);
  }
  return suffixes.length ? `${lifecycleStatus} · ${suffixes.join(" · ")}` : lifecycleStatus;
}

export function isForkHandlerSession(session: Pick<SessionInfo, "status">): boolean {
  const status = session.status?.toLowerCase() ?? "";
  return /(?:^|[\s·])fork-handler(?::|$|[\s·])/.test(status);
}
