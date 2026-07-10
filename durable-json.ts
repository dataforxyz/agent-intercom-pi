import { randomUUID } from "crypto";
import { closeSync, fsyncSync, openSync, renameSync, writeFileSync } from "fs";
import { dirname } from "path";
import { INTERCOM_RUNTIME_FILE_MODE, restrictIntercomRuntimeFile } from "./broker/paths.ts";

export function writeDurableJson(filePath: string, value: unknown): void {
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporaryPath, JSON.stringify(value), { encoding: "utf-8", mode: INTERCOM_RUNTIME_FILE_MODE });
  const fileDescriptor = openSync(temporaryPath, "r");
  try {
    fsyncSync(fileDescriptor);
  } finally {
    closeSync(fileDescriptor);
  }
  renameSync(temporaryPath, filePath);
  restrictIntercomRuntimeFile(filePath);
  if (process.platform !== "win32") {
    const directoryDescriptor = openSync(dirname(filePath), "r");
    try {
      fsyncSync(directoryDescriptor);
    } finally {
      closeSync(directoryDescriptor);
    }
  }
}
