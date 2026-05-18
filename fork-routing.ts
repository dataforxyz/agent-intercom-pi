import { getForkHandlerIdentity, type ForkHandlerIdentity, type ForkHandlerKind } from "./fork-runtime.ts";
import type { SessionInfo } from "./types.ts";

export const INTERCOM_FORK_HANDLER_STATUS_TAG = "fork-handler";
export { getForkHandlerIdentity, type ForkHandlerIdentity, type ForkHandlerKind };

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
