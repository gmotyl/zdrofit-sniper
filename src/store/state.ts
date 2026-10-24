import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Weekday } from "../schedule/opening.js";

export type Outcome = { date: string; result: "Booked" | "Waitlisted" | "Failed"; reason?: string };
export interface User { id: string; email: string; password: string; token?: string; tokenExpiresAt?: string; homeClubId: number }
export interface Sniper {
  id: string; active: boolean; clubId: number; clubName: string; weekday: Weekday; startTime: string;
  className: string; timeTableId?: number; userIds: string[]; lastOutcome?: Record<string /* userId */, Outcome>;
}
export interface State { users: User[]; snipers: Sniper[]; lastClubId?: number }

/** Resolved on every call so the env override applies after import. */
export function dataDir(): string {
  return resolve(process.env.ZDROFIT_SNIPER_DATA ?? "data");
}

function statePath(): string {
  return join(dataDir(), "state.json");
}

export function loadState(): State {
  const file = statePath();
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { users: [], snipers: [] };
    throw err;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Corrupt state file ${file}: ${(err as Error).message}`);
  }
  const s = parsed as Partial<State> | null;
  if (!s || typeof s !== "object" || !Array.isArray(s.users) || !Array.isArray(s.snipers)) {
    throw new Error(`Corrupt state file ${file}: expected an object with users and snipers arrays`);
  }
  return s as State;
}

/** Writes to a temp file in the same dir, then renames over state.json (atomic). */
export function saveState(s: State): void {
  const dir = dataDir();
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, "state.json");
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n", { mode: 0o600 });
  // writeFileSync's mode applies only on create; a stale temp file left by a crash keeps its old mode.
  chmodSync(tmp, 0o600);
  renameSync(tmp, file);
}

/** Slug of the e-mail local part; numeric suffix from 2 when taken. */
export function userIdFromEmail(email: string, taken: string[]): string {
  const base = (email.split("@")[0] ?? "").toLowerCase().replace(/[^a-z0-9]/g, "") || "user";
  if (!taken.includes(base)) return base;
  let n = 2;
  while (taken.includes(`${base}${n}`)) n++;
  return `${base}${n}`;
}
