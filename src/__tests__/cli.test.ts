import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { main, MAIN_MENU, parseMainChoice, type CliDeps } from "../cli.js";
import type { State } from "../store/state.js";
import { scriptedIo } from "../wizard/io.js";

let dir: string;
let stderr: string[];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "zs-cli-"));
  process.env.ZDROFIT_SNIPER_DATA = dir;
  stderr = [];
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr.push(String(chunk));
    return true;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.ZDROFIT_SNIPER_DATA;
  rmSync(dir, { recursive: true, force: true });
});

describe("cli", () => {
  it.each(["setup", "daemon"])("%s exits non-zero naming a corrupt state file", async (command) => {
    const file = join(dir, "state.json");
    writeFileSync(file, "{ not json");
    expect(await main([command])).toBe(1);
    const out = stderr.join("");
    expect(out).toContain(file);
    expect(out.trimEnd().split("\n")).toHaveLength(1);
    expect(out).not.toMatch(/\n\s+at /); // no stack
    expect(existsSync(join(dir, "daemon.pid"))).toBe(false);
  });

  it("setup shows the main menu and dispatches bare numbers", async () => {
    const io = scriptedIo(["x", "1", "2", "0"]);
    const s0: State = { users: [], snipers: [] };
    const s1: State = { users: [], snipers: [], lastClubId: 1 };
    const deps: CliDeps = {
      loadState: () => s0,
      io: () => io,
      usersScreen: vi.fn(async () => s1),
      snipersScreen: vi.fn(async (s: State) => s),
      startDaemon: vi.fn(),
    };
    expect(await main(["setup"], deps)).toBe(0);
    expect(MAIN_MENU).toEqual(["Zdrofit sniper", "  1 - manage users", "  2 - manage snipers", "  0 - exit"]);
    expect(io.printed.slice(1, 5)).toEqual(MAIN_MENU);
    expect(io.printed).toContain("Use: 1, 2, 0 = exit.");
    expect(deps.usersScreen).toHaveBeenCalledWith(s0, io);
    // The snipers screen sees what the users screen saved.
    expect(deps.snipersScreen).toHaveBeenCalledWith(s1, io);
    expect(deps.startDaemon).not.toHaveBeenCalled();
  });

  it("parses only bare menu numbers", () => {
    expect(parseMainChoice(" 1 ")).toBe("users");
    expect(parseMainChoice("2")).toBe("snipers");
    expect(parseMainChoice("0")).toBe("exit");
    expect(parseMainChoice("1A")).toBeUndefined();
    expect(parseMainChoice("3")).toBeUndefined();
  });
});
