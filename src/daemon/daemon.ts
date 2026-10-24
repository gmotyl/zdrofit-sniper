// Long-running daemon: sleeps until the next booking opening, shoots, repeats. No polling.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as api from "../api/client.js";
import { nextOccurrence, type Occurrence } from "../schedule/opening.js";
import { log as fileLog } from "../shot/log.js";
import { runShot } from "../shot/shot.js";
import { dataDir, loadState, type Outcome, type State } from "../store/state.js";

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

/** All active snipers sharing the earliest opening after `now`. */
export function planNext(state: State, now: Date): Plan {
  const all = state.snipers
    .filter((s) => s.active)
    .map((s) => ({ sniperId: s.id, occ: nextOccurrence({ weekday: s.weekday, startTime: s.startTime }, now) }));
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

function pidFile(): string {
  return join(dataDir(), "daemon.pid");
}

function readPid(): number | undefined {
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
  mkdirSync(dataDir(), { recursive: true, mode: 0o700 });
  writeFileSync(pidFile(), `${deps.pid}\n`, { mode: 0o600 });

  const stop = () => {
    // A newer daemon may own the file by now; leave it alone then.
    if (readPid() === deps.pid) rmSync(pidFile(), { force: true });
    deps.exit(0);
  };
  deps.onSignal("SIGTERM", stop);
  deps.onSignal("SIGINT", stop);

  // State is read once; runShot mutates and saves it in place.
  const state = deps.loadState();
  let after = 0; // never re-plan an opening already shot, even if the shot ended before it
  for (;;) {
    const now = deps.now();
    const plan = planNext(state, new Date(Math.max(now.getTime(), after)));
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
    isAlive: (pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (err) {
        return (err as NodeJS.ErrnoException).code === "EPERM";
      }
    },
    onSignal: (sig, handler) => process.on(sig, handler),
    exit: (code) => process.exit(code),
    log: (line) => console.log(`${new Date().toISOString()} ${line}`),
  });
}
