import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { State } from "../../store/state.js";
import { NOT_RUNNING_HINT, saveAndRestart, type RestartDeps } from "../restart.js";

const STATE: State = { users: [], snipers: [], lastClubId: 42 };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "zs-restart-"));
  process.env.ZDROFIT_SNIPER_DATA = dir;
});
afterEach(() => {
  delete process.env.ZDROFIT_SNIPER_DATA;
  rmSync(dir, { recursive: true, force: true });
});

function fakeDeps(alive: number[]) {
  const printed: string[] = [];
  const deps: RestartDeps = {
    isAlive: vi.fn((pid: number) => alive.includes(pid)),
    kill: vi.fn(),
    print: (line) => printed.push(line),
  };
  return { deps, printed };
}

describe("saveAndRestart", () => {
  it("signals a live daemon after save", () => {
    writeFileSync(join(dir, "daemon.pid"), "777\n");
    const { deps, printed } = fakeDeps([777]);
    vi.mocked(deps.kill).mockImplementation(() => {
      // The new state is on disk before the daemon is told to reload.
      expect(JSON.parse(readFileSync(join(dir, "state.json"), "utf8"))).toEqual(STATE);
    });
    saveAndRestart(STATE, deps);
    expect(deps.kill).toHaveBeenCalledTimes(1);
    expect(deps.kill).toHaveBeenCalledWith(777, "SIGTERM");
    expect(printed).not.toContain(NOT_RUNNING_HINT);
  });

  it("prints a hint when no daemon runs", () => {
    // No PID file.
    const none = fakeDeps([]);
    saveAndRestart(STATE, none.deps);
    expect(none.deps.kill).not.toHaveBeenCalled();
    expect(none.printed).toEqual([NOT_RUNNING_HINT]);
    expect(NOT_RUNNING_HINT).toBe("daemon not running — start it with pnpm sniper daemon");
    expect(existsSync(join(dir, "state.json"))).toBe(true);

    // Dead PID.
    writeFileSync(join(dir, "daemon.pid"), "777\n");
    const dead = fakeDeps([]);
    saveAndRestart(STATE, dead.deps);
    expect(dead.deps.isAlive).toHaveBeenCalledWith(777);
    expect(dead.deps.kill).not.toHaveBeenCalled();
    expect(dead.printed).toEqual([NOT_RUNNING_HINT]);
  });
});
