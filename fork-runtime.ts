import * as fallback from "./fork-runtime-fallback.ts";

const runtimeModule = "pi-forks/runtime";
const runtime = await import(runtimeModule)
  .then((module) => module as typeof fallback)
  .catch(() => fallback);

export type ForkHandlerIdentity = fallback.ForkHandlerIdentity;
export type ForkHandlerKind = fallback.ForkHandlerKind;
export type ForkSource = fallback.ForkSource;

export const buildForkHandlerEnv = runtime.buildForkHandlerEnv;
export const buildForkRunPaths = runtime.buildForkRunPaths;
export const buildPiForkArgs = runtime.buildPiForkArgs;
export const getForkHandlerIdentity = runtime.getForkHandlerIdentity;
export const getForkHandlersFile = runtime.getForkHandlersFile;
export const launchDetachedFork = runtime.launchDetachedFork;
export const readOptionalText = runtime.readOptionalText;
export const truncateText = runtime.truncateText;
export const writeJsonAtomic = runtime.writeJsonAtomic;
