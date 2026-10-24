import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { nextOccurrence } from "../../schedule/opening.js";
import type { Sniper, State } from "../../store/state.js";
import { isDaemonAlive, longSleep, MAX_TIMEOUT, planNext, runDaemon, type DaemonDeps, type LivenessProbe } from "../daemon.js";

const MIN = 60_000;
// Thursday 2026-10-22 12:00 Warsaw (UTC+2).
const NOW = new Date("2026-10-22T10:00:00.000Z");

const sniper = (over: Partial<Sniper>): Sniper => ({
  id: "s", active: true, clubId: 42, clubName: "Club", weekday: 1, startTime: "18:00", className: "Pilates", userIds: ["greg"], ...over,
});

class Exit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

const never = () => new Promise<void>(() => {});
// Every fake sleep yields a macrotask, so a runaway loop starves nothing and fails instead of hanging.
const tick = () => new Promise<void>((r) => setImmediate(r));
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "zs-daemon-"));
  process.env.ZDROFIT_SNIPER_DATA = dir;
});
afterEach(() => {
  delete process.env.ZDROFIT_SNIPER_DATA;
  rmSync(dir, { recursive: true, force: true });
});

function fakeDeps(state: State, over: Partial<DaemonDeps> = {}) {
  const signals: Record<string, () => void> = {};
  const lines: string[] = [];
  let clock = NOW.getTime();
  const deps: DaemonDeps = {
    pid: 4242,
    now: () => new Date(clock),
    sleep: vi.fn(async (ms: number) => {
      await tick();
      clock += ms;
    }),
    loadState: vi.fn(() => state),
    runShot: vi.fn(never as unknown as DaemonDeps["runShot"]),
    isAlive: vi.fn(() => false),
    onSignal: (sig, handler) => {
      signals[sig] = handler;
    },
    exit: (code) => {
      throw new Exit(code);
    },
    log: (line) => lines.push(line),
    ...over,
  };
  return { deps, signals, lines, advance: (ms: number) => (clock += ms) };
}

describe("planNext", () => {
  it("plans the earliest opening across active snipers", () => {
    const state: State = {
      users: [],
      snipers: [
        sniper({ id: "mon", weekday: 1, startTime: "18:00" }), // opens Sat 24 18:00
        sniper({ id: "sat", weekday: 6, startTime: "20:00" }), // opens Thu 22 20:00 (today)
        sniper({ id: "sat2", weekday: 6, startTime: "20:00", clubId: 7 }),
        sniper({ id: "off", weekday: 6, startTime: "19:00", active: false }), // would be earlier
      ],
    };
    const plan = planNext(state, NOW);
    expect(plan.map((p) => p.sniperId)).toEqual(["sat", "sat2"]);
    expect(plan[0]!.occ).toEqual(nextOccurrence({ weekday: 6, startTime: "20:00" }, NOW));
    expect(plan[0]!.occ.opening.toISOString()).toBe("2026-10-22T18:00:00.000Z");
  });
});

describe("runDaemon", () => {
  it("plans the earliest opening across active snipers", async () => {
    const state: State = {
      users: [],
      snipers: [sniper({ id: "s1", weekday: 6, startTime: "20:00" }), sniper({ id: "s2", weekday: 6, startTime: "20:00" }), sniper({ id: "s3" })],
    };
    const started: string[] = [];
    const { deps, lines } = fakeDeps(state);
    // The first shot finishes only once the second has started: sequential shots would hang.
    let bothStarted!: () => void;
    const gate = new Promise<void>((r) => (bothStarted = r));
    deps.runShot = vi.fn(async (_s, id) => {
      started.push(id);
      if (started.length === 2) bothStarted();
      await gate;
      return {};
    });
    let sleeps = 0;
    const clockSleep = deps.sleep;
    deps.sleep = vi.fn(async (ms: number) => {
      // Stop after the second planning cycle.
      if (++sleeps > 1) return never();
      await clockSleep(ms);
    });
    void runDaemon(deps);
    await settle();

    // Woke at T−10 min: opening Thu 20:00 Warsaw = 18:00Z, now 10:00Z → 8 h − 10 min.
    expect(deps.sleep).toHaveBeenNthCalledWith(1, 8 * 60 * MIN - 10 * MIN);
    expect(deps.runShot).toHaveBeenCalledTimes(2);
    const [, , occ] = vi.mocked(deps.runShot).mock.calls[0]!;
    expect(occ.opening.toISOString()).toBe("2026-10-22T18:00:00.000Z");
    expect(lines).toContain("next opening 2026-10-22T18:00:00.000Z for sniper(s) s1,s2");
    // Next cycle reuses the in-memory state and moves on to s3's opening.
    expect(lines).toContain("next opening 2026-10-24T16:00:00.000Z for sniper(s) s3");
    expect(deps.loadState).toHaveBeenCalledTimes(1);
    expect(readFileSync(join(dir, "daemon.pid"), "utf8").trim()).toBe("4242");
  });

  it("does not shoot the same opening twice when a shot ends early", async () => {
    const state: State = { users: [], snipers: [sniper({ id: "s1", weekday: 6, startTime: "20:00" })] };
    const { deps, lines } = fakeDeps(state);
    deps.runShot = vi.fn(async () => ({})); // returns before T (e.g. slot not found at T−5)
    let sleeps = 0;
    const clockSleep = deps.sleep;
    deps.sleep = vi.fn(async (ms: number) => {
      if (++sleeps > 1) return never();
      await clockSleep(ms);
    });
    void runDaemon(deps);
    await settle();
    expect(deps.runShot).toHaveBeenCalledTimes(1);
    expect(lines.at(-1)).toBe("next opening 2026-10-29T19:00:00.000Z for sniper(s) s1");
  });

  it("keeps planning after a shot throws", async () => {
    const state: State = { users: [], snipers: [sniper({ id: "s1", weekday: 6, startTime: "20:00" })] };
    const { deps, lines } = fakeDeps(state);
    deps.runShot = vi.fn(async () => {
      throw new Error("boom");
    });
    let sleeps = 0;
    const clockSleep = deps.sleep;
    deps.sleep = vi.fn(async (ms: number) => {
      if (++sleeps > 1) return never();
      await clockSleep(ms);
    });
    const run = runDaemon(deps);
    let crashed: unknown;
    run.catch((err: unknown) => (crashed = err));
    await settle();
    expect(crashed).toBeUndefined();
    expect(lines).toContain("sniper=s1 shot error: boom");
    // Planned the following week's opening after the failed shot.
    expect(lines.at(-1)).toBe("next opening 2026-10-29T19:00:00.000Z for sniper(s) s1");
    expect(deps.sleep).toHaveBeenCalledTimes(2);
  });

  it("skips a sniper with an unschedulable start time", async () => {
    const state: State = {
      users: [],
      snipers: [sniper({ id: "bad", startTime: "25:99" }), sniper({ id: "nan", startTime: "abc" }), sniper({ id: "ok", weekday: 6, startTime: "20:00" })],
    };
    const logged: string[] = [];
    expect(planNext(state, NOW, (l) => logged.push(l)).map((p) => p.sniperId)).toEqual(["ok"]);
    expect(logged).toHaveLength(2);
    expect(logged[0]).toMatch(/sniper=bad skipped/);
    expect(logged[1]).toMatch(/sniper=nan skipped/);

    // In the daemon, a lone bad sniper idles instead of crashing.
    const { deps, lines } = fakeDeps({ users: [], snipers: [sniper({ id: "bad", startTime: "x" })] }, { sleep: vi.fn(never) });
    const run = runDaemon(deps);
    let crashed: unknown;
    run.catch((err: unknown) => (crashed = err));
    await settle();
    expect(crashed).toBeUndefined();
    expect(lines).toContain("no active sniper");
    expect(lines.some((l) => /sniper=bad skipped/.test(l))).toBe(true);
  });

  it("writes no PID file when state.json is corrupt", async () => {
    const { deps } = fakeDeps({ users: [], snipers: [] }, {
      loadState: vi.fn(() => {
        throw new Error("Corrupt state file /x/state.json: bad");
      }),
    });
    await expect(runDaemon(deps)).rejects.toThrow(/Corrupt state file/);
    expect(existsSync(join(dir, "daemon.pid"))).toBe(false);
  });

  it("ignores inactive snipers and idles with none", async () => {
    const state: State = { users: [], snipers: [sniper({ id: "off", active: false })] };
    expect(planNext(state, NOW)).toEqual([]);
    const { deps, lines } = fakeDeps(state);
    let sleeps = 0;
    deps.sleep = vi.fn(async () => {
      await tick();
      if (++sleeps > 3) return never();
    });
    void runDaemon(deps);
    await settle();
    expect(lines).toContain("no active sniper");
    expect(deps.runShot).not.toHaveBeenCalled();
    // Only the keep-alive timer, at the cap, with no work in between.
    expect(vi.mocked(deps.sleep).mock.calls.every(([ms]) => ms === MAX_TIMEOUT)).toBe(true);
    expect(deps.loadState).toHaveBeenCalledTimes(1);
  });

  it("refuses to start when another daemon is alive", async () => {
    writeFileSync(join(dir, "daemon.pid"), "777\n");
    const { deps, lines } = fakeDeps({ users: [], snipers: [] }, { isAlive: vi.fn((pid) => pid === 777) });
    await expect(runDaemon(deps)).rejects.toEqual(new Exit(1));
    expect(readFileSync(join(dir, "daemon.pid"), "utf8")).toBe("777\n");
    expect(deps.loadState).not.toHaveBeenCalled();
    expect(lines.join("\n")).toMatch(/already running.*777/);
  });

  it("overwrites a stale PID file", async () => {
    writeFileSync(join(dir, "daemon.pid"), "777\n");
    const { deps } = fakeDeps({ users: [], snipers: [] }, { sleep: vi.fn(never) });
    void runDaemon(deps);
    await settle();
    expect(deps.isAlive).toHaveBeenCalledWith(777);
    expect(readFileSync(join(dir, "daemon.pid"), "utf8").trim()).toBe("4242");
  });

  it("removes its PID file on SIGTERM", async () => {
    const { deps, signals } = fakeDeps({ users: [], snipers: [] }, { sleep: vi.fn(never) });
    void runDaemon(deps);
    await settle();
    const pidFile = join(dir, "daemon.pid");
    expect(existsSync(pidFile)).toBe(true);
    expect(() => signals.SIGTERM!()).toThrow(new Exit(0));
    expect(existsSync(pidFile)).toBe(false);
  });

  it("leaves a PID file it no longer owns on SIGTERM", async () => {
    const { deps, signals } = fakeDeps({ users: [], snipers: [] }, { sleep: vi.fn(never) });
    void runDaemon(deps);
    await settle();
    const pidFile = join(dir, "daemon.pid");
    writeFileSync(pidFile, "999\n");
    expect(() => signals.SIGTERM!()).toThrow(new Exit(0));
    expect(readFileSync(pidFile, "utf8")).toBe("999\n");
  });
});

describe("isDaemonAlive", () => {
  const probe = (kill: "ok" | "ESRCH" | "EPERM", cmdline: string | undefined): LivenessProbe => ({
    kill: () => {
      if (kill !== "ok") throw Object.assign(new Error(kill), { code: kill });
    },
    readCmdline: () => {
      if (cmdline === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return cmdline;
    },
  });

  it("is false for a dead PID", () => {
    expect(isDaemonAlive(1, probe("ESRCH", "node\0dist/cli.js\0daemon\0"))).toBe(false);
  });

  it("is true for a live daemon, also when owned by another user", () => {
    expect(isDaemonAlive(1, probe("ok", "node\0dist/cli.js\0daemon\0"))).toBe(true);
    expect(isDaemonAlive(1, probe("EPERM", "node\0dist/cli.js\0daemon\0"))).toBe(true);
  });

  it("is false when the PID was reused by an unrelated process", () => {
    expect(isDaemonAlive(1, probe("ok", "/usr/bin/vim\0notes.txt\0"))).toBe(false);
  });

  it("falls back to kill-0 when /proc is unreadable", () => {
    expect(isDaemonAlive(1, probe("ok", undefined))).toBe(true);
  });
});

describe("longSleep", () => {
  it("chains sleeps longer than the setTimeout cap", async () => {
    expect(MAX_TIMEOUT).toBe(2 ** 31 - 1);
    const sleep = vi.fn(async () => {});
    await longSleep(2 * MAX_TIMEOUT + 5, sleep);
    expect(sleep.mock.calls).toEqual([[MAX_TIMEOUT], [MAX_TIMEOUT], [5]]);
    sleep.mockClear();
    await longSleep(-3, sleep);
    expect(sleep).not.toHaveBeenCalled();
  });
});
