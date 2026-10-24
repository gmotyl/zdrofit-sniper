import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { dataDir } from "../store/state.js";

/** Appends `line` with an ISO timestamp to <dataDir>/logs/YYYY-MM.log (UTC month). */
export function log(line: string): void {
  const now = new Date().toISOString();
  const dir = join(dataDir(), "logs");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  appendFileSync(join(dir, `${now.slice(0, 7)}.log`), `${now} ${line}\n`, { mode: 0o600 });
}
