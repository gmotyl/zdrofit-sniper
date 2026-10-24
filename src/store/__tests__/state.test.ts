import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync, readdirSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dataDir, loadState, saveState, userIdFromEmail, type State } from "../state.js";

// Pass-through spy on renameSync so the test can see the temp + rename step.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});

describe("state store", () => {
  const originalData = process.env.ZDROFIT_SNIPER_DATA;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "zdrofit-state-"));
    process.env.ZDROFIT_SNIPER_DATA = join(dir, "data");
    vi.mocked(renameSync).mockClear();
  });
  afterEach(() => {
    if (originalData === undefined) delete process.env.ZDROFIT_SNIPER_DATA;
    else process.env.ZDROFIT_SNIPER_DATA = originalData;
    rmSync(dir, { recursive: true, force: true });
  });

  it("saves atomically with mode 0600", () => {
    const state: State = {
      users: [{ id: "greg", email: "greg@x.pl", password: "secret", homeClubId: 1 }],
      snipers: [],
      lastClubId: 1,
    };
    saveState(state);
    const file = join(dir, "data", "state.json");
    expect(renameSync).toHaveBeenCalledTimes(1);
    const [from, to] = vi.mocked(renameSync).mock.calls[0]!;
    expect(to).toBe(file);
    expect(from).not.toBe(file);
    expect(existsSync(String(from))).toBe(false);
    expect(readdirSync(join(dir, "data"))).toEqual(["state.json"]);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(loadState()).toEqual(state);
  });

  it("fixes the mode of a stale temp file left by a crash", () => {
    const data = join(dir, "data");
    mkdirSync(data, { recursive: true });
    const tmp = join(data, `state.json.${process.pid}.tmp`);
    writeFileSync(tmp, "stale");
    chmodSync(tmp, 0o644);
    saveState({ users: [], snipers: [] });
    expect(statSync(join(data, "state.json")).mode & 0o777).toBe(0o600);
  });

  it("throws with the path when the state lacks users or snipers arrays", () => {
    const file = join(dir, "data", "state.json");
    for (const bad of ["null", "[]", "{}", '{"users":[]}', '{"users":{},"snipers":[]}']) {
      saveState({ users: [], snipers: [] });
      writeFileSync(file, bad);
      expect(() => loadState(), bad).toThrow(file);
    }
  });

  it("returns empty state when the file is missing", () => {
    expect(loadState()).toEqual({ users: [], snipers: [] });
  });

  it("throws with the path on corrupt JSON and leaves the file", () => {
    saveState({ users: [], snipers: [] });
    const file = join(dir, "data", "state.json");
    writeFileSync(file, "{ not json");
    expect(() => loadState()).toThrow(file);
    expect(readFileSync(file, "utf8")).toBe("{ not json");
  });

  it("honours ZDROFIT_SNIPER_DATA", () => {
    const other = join(dir, "other");
    process.env.ZDROFIT_SNIPER_DATA = other;
    expect(dataDir()).toBe(other);
    saveState({ users: [], snipers: [] });
    expect(existsSync(join(other, "state.json"))).toBe(true);
    delete process.env.ZDROFIT_SNIPER_DATA;
    expect(dataDir()).toBe(join(process.cwd(), "data"));
  });

  it("derives a unique user id from the e-mail", () => {
    expect(userIdFromEmail("greg@x.pl", [])).toBe("greg");
    expect(userIdFromEmail("greg@x.pl", ["greg"])).toBe("greg2");
    expect(userIdFromEmail("Greg.Motyl+1@x.pl", ["gregmotyl1", "gregmotyl12"])).toBe("gregmotyl13");
    expect(userIdFromEmail("...@x.pl", [])).toBe("user");
  });
});
