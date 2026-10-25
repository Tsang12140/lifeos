import { appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

/** Append a structured diagnostic event beside the API's ordinary request logs. */
export function writeApiLogEvent(event: string, fields: Readonly<Record<string, unknown>>): void {
  try {
    const now = new Date();
    const logDirectory = process.env.LIFEOS_LOG_DIR ?? resolve(process.env.LIFEOS_DATA_DIR ?? process.cwd(), "..", "logs");
    mkdirSync(logDirectory, { recursive: true });
    const entry = { at: now.toISOString(), event, ...fields };
    appendFileSync(resolve(logDirectory, `api-${now.toISOString().slice(0, 10)}.log`), `${JSON.stringify(entry)}\n`);
  } catch {
    // A diagnostic failure must never affect the request or the API process.
  }
}
