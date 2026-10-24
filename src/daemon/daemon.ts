// Long-running daemon: sleeps until the next booking opening, shoots, repeats. No polling.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as api from "../api/client.js";
import { nextOccurrence, type Occurrence } from "../schedule/opening.js";
import { log as fileLog } from "../shot/log.js";
import { runShot } from "../shot/shot.js";
import { dataDir, loadState, type Outcome, type Sniper, type State } from "../store/state.js";

/** Node's setTimeout cap; longer delays overflow to ~1 ms. */
export const MAX_TIMEOUT = 2 ** 31 - 1;
const WAKE_BEFORE = 10 * 60_000; // runShot takes over from T−10 min

export interface DaemonDeps {
  pid: number;
  now(): Date;
  /** One timer; callers keep `ms` within MAX_TIMEOUT. */
  sleep(ms: number): Promise<void>;
  loadState(): State;
  runShot(state: State, sniperId: string, occ: Occurrence): Promise<Record<string, Outcome>>;
  isAlive(pid: number): boolean;
  onSignal(sig: "SIGTERM" | "SIGINT", handler: () => void): void;
  exit(code: number): never;
  log(line: string): void;
}

export type Plan = { sniperId: string; occ: Occurrence }[];

const START_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The sniper's next occurrence, or undefined when its weekday/startTime can't be scheduled. */
function occurrenceOf(s: Sniper, now: Date): Occurrence | undefined {
  // nextOccurrence loops forever on NaN times, so validate before calling it.
  if (!Number.isInteger(s.weekday) || s.weekday < 1 || s.weekday > 7) return undefined;
  if (typeof s.startTime !== "string" || !START_TIME.test(s.startTime)) return undefined;
  try {
    const occ = nextOccurrence({ weekday: s.weekday, startTime: s.startTime }, now);
    return Number.isFinite(occ.opening.getTime()) ? occ : undefined;
  } catch {
    return undefined;
  }
}

/**
 * All active snipers sharing the earliest opening after `now`.
 * A sniper whose occurrence can't be computed is skipped with one log line, not thrown on
 * (a throw would crash the daemon into a restart loop).
 */
export function planNext(state: State, now: Date, log: (line: string) => void = () => {}): Plan {
  const all: Plan = [];
  for (const s of state.snipers.filter((x) => x.active)) {
    const occ = occurrenceOf(s, now);
    if (occ) all.push({ sniperId: s.id, occ });
    else log(`sniper=${s.id} skipped: cannot schedule weekday=${JSON.stringify(s.weekday)} startTime=${JSON.stringify(s.startTime)}`);
  }
  const earliest = Math.min(...all.map((p) => p.occ.opening.getTime()));
  return all.filter((p) => p.occ.opening.getTime() === earliest);
}

/** Sleeps `ms` in chunks no longer than the setTimeout cap. */
export async function longSleep(ms: number, sleep: (ms: number) => Promise<void>): Promise<void> {
  while (ms > 0) {
    const chunk = Math.min(ms, MAX_TIMEOUT);
    await sleep(chunk);
    ms -= chunk;
  }
}

export function pidFile(): string {
  return join(dataDir(), "daemon.pid");
}

export interface LivenessProbe {
  /** `process.kill(pid, 0)`; throws ESRCH when gone, EPERM when alive but not ours. */
  kill(pid: number, signal: 0): void;
  /** Raw `/proc/<pid>/cmdline`; throws when unreadable (no procfs, e.g. macOS). */
  readCmdline(pid: number): string;
}

const realProbe: LivenessProbe = {
  kill: (pid, signal) => {
    process.kill(pid, signal);
  },
  readCmdline: (pid) => readFileSync(`/proc/${pid}/cmdline`, "utf8"),
};

/**
 * True when `pid` is a live sniper daemon. A PID reused by an unrelated process after a
 * crash does not count: when procfs is readable its cmdline must mention `daemon`.
 */
export function isDaemonAlive(pid: number, probe: LivenessProbe = realProbe): boolean {
  try {
    probe.kill(pid, 0);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  let cmdline: string;
  try {
    cmdline = probe.readCmdline(pid);
  } catch {
    return true; // no procfs: kill-0 is all we can tell
  }
  return cmdline.includes("daemon");
}

export function readPid(): number | undefined {
  try {
    const pid = Number.parseInt(readFileSync(pidFile(), "utf8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

export async function runDaemon(deps: DaemonDeps): Promise<never> {
  const other = readPid();
  if (other !== undefined && other !== deps.pid && deps.isAlive(other)) {
    deps.log(`daemon already running (pid ${other}); exiting`);
    return deps.exit(1);
  }
  // State is read once, before the PID file: a corrupt state.json must leave no stale PID.
  // runShot mutates and saves it in place.
  const state = deps.loadState();
  mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  writeFileSync(pidFile(), `${deps.pid}\n`, { mode: 0o600 });

  const stop = () => {
    // A newer daemon may own the file by now; leave it alone then.
    if (readPid() === deps.pid) rmSync(pidFile(), { force: true });
    deps.exit(0);
  };
  deps.onSignal("SIGTERM", stop);
  deps.onSignal("SIGINT", stop);

  let after = 0; // never re-plan an opening already shot, even if the shot ended before it
  for (;;) {
    const now = deps.now();
    const plan = planNext(state, new Date(Math.max(now.getTime(), after)), deps.log);
    if (plan.length === 0) {
      deps.log("no active sniper");
      // Keep-alive only: the wizard restarts the daemon after any change.
      for (;;) await deps.sleep(MAX_TIMEOUT);
    }
    const opening = plan[0]!.occ.opening;
    deps.log(`next opening ${opening.toISOString()} for sniper(s) ${plan.map((p) => p.sniperId).join(",")}`);
    await longSleep(opening.getTime() - WAKE_BEFORE - now.getTime(), deps.sleep);
    await Promise.all(
      plan.map(({ sniperId, occ }) =>
        deps.runShot(state, sniperId, occ).catch((err: unknown) => {
          deps.log(`sniper=${sniperId} shot error: ${(err as Error).message}`);
        }),
      ),
    );
    after = opening.getTime();
  }
}

/** Real process wiring for the `daemon` subcommand. */
export function startDaemon(): Promise<never> {
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const shotDeps = { api, now: () => new Date(), sleep: (ms: number) => longSleep(ms, sleep), log: fileLog };
  return runDaemon({
    pid: process.pid,
    now: () => new Date(),
    sleep,
    loadState,
    runShot: (state, sniperId, occ) => runShot(state, sniperId, occ, shotDeps),
    isAlive: (pid) => isDaemonAlive(pid),
    onSignal: (sig, handler) => process.on(sig, handler),
    exit: (code) => process.exit(code),
    log: (line) => console.log(`${new Date().toISOString()} ${line}`),
  });
}
