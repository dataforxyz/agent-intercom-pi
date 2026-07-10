import { closeSync, constants, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { INTERCOM_RUNTIME_FILE_MODE, restrictIntercomRuntimeFile } from "./paths.ts";

function ownerPid(path: string): number | null {
  try {
    const pid = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function pidIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export function acquireBrokerOwnership(path: string, pid = process.pid): void {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, INTERCOM_RUNTIME_FILE_MODE);
      try {
        writeFileSync(fd, String(pid));
      } finally {
        closeSync(fd);
      }
      restrictIntercomRuntimeFile(path);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existingPid = ownerPid(path);
      if (existingPid !== null && pidIsAlive(existingPid)) {
        throw new Error(`Intercom broker already owned by live process ${existingPid}`);
      }
      try {
        unlinkSync(path);
      } catch (unlinkError) {
        if ((unlinkError as NodeJS.ErrnoException).code !== "ENOENT") throw unlinkError;
      }
    }
  }
  throw new Error("Could not acquire intercom broker ownership");
}

export function releaseBrokerOwnership(path: string, pid = process.pid): void {
  if (ownerPid(path) !== pid) return;
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

export function hasBrokerOwnership(path: string, pid = process.pid): boolean {
  return ownerPid(path) === pid;
}

