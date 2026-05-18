const HANDLER_RECEIPT_METADATA_PREFIXES = [
  "intercom fork handler ",
  "Handler:",
  "Message:",
  "From:",
  "Exit:",
  "Output:",
  "Errors:",
];

function isCompactedHandlerReceipt(content: string): boolean {
  return /\bhandler receipt \(compacted for /i.test(content.split(/\r?\n/, 1)[0] ?? "");
}

function hasEmptyOrAbsentErrorsLine(lines: string[]): boolean {
  const errorsLine = lines.find((line) => /^Errors:/i.test(line));
  if (!errorsLine) return true;
  return /^Errors:\s*none\b/i.test(errorsLine) || /\(0 B\)\s*$/i.test(errorsLine);
}

function isRoutineSuccessfulHandlerReceipt(content: string): boolean {
  if (isCompactedHandlerReceipt(content)) return false;
  const lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const firstLine = lines[0] ?? "";
  if (!/\b(complete|completed)\b/i.test(firstLine)) return false;
  if (/\b(failed|blocked|needs? attention|error)\b/i.test(firstLine)) return false;
  const exitLine = lines.find((line) => /^Exit:/i.test(line));
  return (!exitLine || /^Exit:\s*0\b/i.test(exitLine)) && hasEmptyOrAbsentErrorsLine(lines);
}

function truncateReceiptLine(line: string, maxChars: number): string {
  return line.length <= maxChars ? line : `${line.slice(0, maxChars)}…`;
}

function isHandlerReceiptMetadataLine(line: string): boolean {
  const lower = line.toLowerCase();
  return HANDLER_RECEIPT_METADATA_PREFIXES.some((prefix) => lower.startsWith(prefix.toLowerCase()));
}

export function compactRoutineIntercomHandlerReceipt(content: string): string {
  if (!isRoutineSuccessfulHandlerReceipt(content)) return content;
  const lines = content.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const kept: string[] = ["Intercom handler receipt (compacted for model context; routine success)."];
  const keptIndexes = new Set<number>();
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (!isHandlerReceiptMetadataLine(line)) continue;
    kept.push(truncateReceiptLine(line, 320));
    keptIndexes.add(index);
  }
  let summaryCount = 0;
  for (let index = 0; index < lines.length && summaryCount < 3; index++) {
    if (keptIndexes.has(index)) continue;
    const line = lines[index]!;
    if (isHandlerReceiptMetadataLine(line)) continue;
    kept.push(`Summary: ${truncateReceiptLine(line, 240)}`);
    keptIndexes.add(index);
    summaryCount++;
  }
  const omitted = lines.length - keptIndexes.size;
  if (omitted > 0) kept.push(`Omitted ${omitted} routine line(s); use Output/Errors paths for full logs if needed.`);
  return kept.join("\n");
}

export function compactIntercomHandlerMessages(messages: unknown[]): unknown[] {
  let changed = false;
  const compacted = messages.map((message) => {
    const m = message as { role?: string; customType?: string; content?: unknown };
    if (m?.role !== "custom" || m.customType !== "intercom_fork_handler" || typeof m.content !== "string") return message;
    const content = compactRoutineIntercomHandlerReceipt(m.content);
    if (content === m.content) return message;
    changed = true;
    return { ...m, content };
  });
  return changed ? compacted : messages;
}
