import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BookResult, ClassItem, Session } from "../../api/client.js";
import { LoginRefused } from "../../api/client.js";
import type { Occurrence } from "../../schedule/opening.js";
import { loadState, type State } from "../../store/state.js";
import { log as fileLog } from "../log.js";
import { runShot, type ShotDeps } from "../shot.js";

type Api = ShotDeps["api"];

const T = new Date("2026-10-24T18:00:00.000Z"); // opening
const occ: Occurrence = { date: "2026-10-26", start: new Date("2026-10-26T18:00:00.000Z"), opening: T };
const DAY = 86_400_000;
const CLASS_ID = 500;
const MEMBER = { greg: 1, ola: 2 } as const;

function freshState(): State {
  return {
    users: [
      { id: "greg", email: "greg@example.com", password: "pw-greg-SECRET", token: "tok-greg-old", tokenExpiresAt: new Date(T.getTime() + 30 * DAY).toISOString(), homeClubId: 42, memberId: MEMBER.greg },
      { id: "ola", email: "ola@example.com", password: "pw-ola-SECRET", token: "tok-ola-old", tokenExpiresAt: new Date(T.getTime() + 30 * DAY).toISOString(), homeClubId: 42, memberId: MEMBER.ola },
    ],
    snipers: [
      { id: "s1", active: true, clubId: 42, clubName: "Zdrofit Pruszków", weekday: 1, startTime: "18:00", className: "Pilates", timeTableId: 18, userIds: ["greg", "ola"] },
    ],
  };
}

const slot = (over: Partial<ClassItem> = {}): ClassItem => ({
  id: CLASS_ID, timeTableId: 18, name: "Pilates", start: "2026-10-26T18:00:00", status: "Bookable", userIds: [], ...over,
});

/** Fake api: bookClass ok by default; authenticated dailyClasses lists everyone who got ok. */
function fakeApi() {
  const booked = new Set<number>();
  const memberOfToken = (token: string) => (token.startsWith("tok-greg") ? MEMBER.greg : MEMBER.ola);
  const api = {
    login: vi.fn(async (email: string): Promise<Session> => {
      const who = email.split("@")[0]!;
      return { token: `tok-${who}-new`, expiresAt: new Date(T.getTime() + 30 * DAY).toISOString(), homeClubId: 42, memberId: (MEMBER as Record<string, number>)[who]! };
    }),
    dailyClasses: vi.fn(async (_club: number, _date: string, token?: string): Promise<ClassItem[]> =>
      [slot({ userIds: token ? [...booked] : [] })]),
    bookClass: vi.fn(async (token: string): Promise<BookResult> => {
      booked.add(memberOfToken(token));
      return { ok: true };
    }),
  };
  return api;
}

const lines: string[] = [];
function deps(api: unknown, log: (l: string) => void = (l) => lines.push(l)): ShotDeps {
  return {
    api: { LoginRefused, ...(api as object) } as unknown as Api,
    now: () => new Date(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log,
  };
}

async function shoot(state: State, d: ShotDeps) {
  const p = runShot(state, "s1", occ, d);
  await vi.runAllTimersAsync();
  return p;
}

describe("shot runner", () => {
  const originalData = process.env.ZDROFIT_SNIPER_DATA;
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "zdrofit-shot-"));
    process.env.ZDROFIT_SNIPER_DATA = join(dir, "data");
    vi.useFakeTimers({ now: new Date(T.getTime() - 15 * 60_000) });
    lines.length = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
    if (originalData === undefined) delete process.env.ZDROFIT_SNIPER_DATA;
    else process.env.ZDROFIT_SNIPER_DATA = originalData;
    rmSync(dir, { recursive: true, force: true });
  });

  it("refreshes tokens that expire within a day", async () => {
    const state = freshState();
    state.users[0]!.tokenExpiresAt = new Date(T.getTime() + 12 * 3_600_000).toISOString();
    const loginAt: number[] = [];
    const api = fakeApi();
    api.login.mockImplementation(async (email: string) => {
      loginAt.push(Date.now());
      return { token: "tok-greg-new", expiresAt: "2026-11-23T00:00:00.000Z", homeClubId: 42, memberId: MEMBER.greg };
    });
    const out = await shoot(state, deps(api));
    expect(api.login).toHaveBeenCalledTimes(1);
    expect(api.login).toHaveBeenCalledWith("greg@example.com", "pw-greg-SECRET");
    expect(loginAt).toEqual([T.getTime() - 10 * 60_000]);
    expect(state.users[0]).toMatchObject({ token: "tok-greg-new", tokenExpiresAt: "2026-11-23T00:00:00.000Z" });
    expect(loadState().users[0]!.token).toBe("tok-greg-new");
    expect(api.bookClass.mock.calls.map((c) => c[0]).sort()).toEqual(["tok-greg-new", "tok-ola-old"]);
    expect(out.greg!.result).toBe("Booked");
  });

  it("does not refresh a token valid for more than a day", async () => {
    const state = freshState();
    state.users[0]!.tokenExpiresAt = new Date(T.getTime() + 25 * 3_600_000).toISOString();
    const api = fakeApi();
    const out = await shoot(state, deps(api));
    expect(api.login).not.toHaveBeenCalled();
    expect(api.bookClass.mock.calls.map((c) => c[0]).sort()).toEqual(["tok-greg-old", "tok-ola-old"]);
    expect(out.greg!.result).toBe("Booked");
  });

  it("saves outcomes even when logging throws", async () => {
    const state = freshState();
    const out = await shoot(state, deps(fakeApi(), () => { throw new Error("disk full"); }));
    expect(out.greg!.result).toBe("Booked");
    expect(state.snipers[0]!.lastOutcome).toEqual(out);
    expect(loadState().snipers[0]!.lastOutcome).toEqual(out);
  });

  it("a refused login fails only that user", async () => {
    const state = freshState();
    delete state.users[0]!.token;
    const api = fakeApi();
    api.login.mockRejectedValue(new LoginRefused(401));
    const out = await shoot(state, deps(api));
    expect(out.greg).toEqual({ date: "2026-10-26", result: "Failed", reason: "login" });
    expect(out.ola).toEqual({ date: "2026-10-26", result: "Booked" });
    expect(api.bookClass.mock.calls.map((c) => c[0])).toEqual(["tok-ola-old"]);
  });

  it("missing slot fails everyone without booking", async () => {
    const api = fakeApi();
    api.dailyClasses.mockResolvedValue([slot({ timeTableId: 99, name: "Zumba" })]);
    const out = await shoot(freshState(), deps(api));
    expect(out).toEqual({
      greg: { date: "2026-10-26", result: "Failed", reason: "slot not found" },
      ola: { date: "2026-10-26", result: "Failed", reason: "slot not found" },
    });
    expect(api.bookClass).not.toHaveBeenCalled();
  });

  it("retries early refusals every 300 ms until accepted", async () => {
    const state = freshState();
    state.snipers[0]!.userIds = ["greg"];
    const at: number[] = [];
    const api = fakeApi();
    const early: BookResult = { ok: false, status: 499, early: true };
    let n = 0;
    api.bookClass.mockImplementation(async () => {
      at.push(Date.now());
      return ++n <= 3 ? early : { ok: true };
    });
    api.dailyClasses.mockImplementation(async (_c: number, _d: string, token?: string) => [slot({ userIds: token ? [MEMBER.greg] : [] })]);
    const out = await shoot(state, deps(api));
    expect(at).toHaveLength(4);
    expect(at[0]).toBe(T.getTime() - 2000);
    expect(at.slice(1).map((t, i) => t - at[i]!)).toEqual([300, 300, 300]);
    expect(out.greg!.result).toBe("Booked");
  });

  it("fires all users concurrently", async () => {
    const events: string[] = [];
    const api = fakeApi();
    api.bookClass.mockImplementation(async (token: string) => {
      events.push(`start ${token}`);
      await new Promise((r) => setTimeout(r, 50));
      events.push(`end ${token}`);
      return { ok: true };
    });
    await shoot(freshState(), deps(api));
    expect(events.slice(0, 2).every((e) => e.startsWith("start"))).toBe(true);
    expect(events).toHaveLength(4);
  });

  it("gives up after a 60 s budget", async () => {
    const state = freshState();
    state.snipers[0]!.userIds = ["greg"];
    const at: number[] = [];
    const api = fakeApi();
    let flip = false;
    api.bookClass.mockImplementation(async () => {
      at.push(Date.now());
      // Alternate early refusals and network errors; both are retried.
      flip = !flip;
      if (flip) throw new TypeError("fetch failed");
      return { ok: false, status: 499, early: true, correlationId: "corr-1" };
    });
    const out = await shoot(state, deps(api));
    expect(out.greg).toEqual({ date: "2026-10-26", result: "Failed", reason: "retry budget" });
    const offsets = at.map((t) => t - at[0]!);
    expect(offsets.at(-1)).toBeGreaterThanOrEqual(59_700);
    expect(offsets.filter((o) => o > 60_000)).toEqual([]);
  });

  it("still books a full class", async () => {
    const api = fakeApi();
    api.dailyClasses.mockImplementation(async (_c: number, _d: string, token?: string) =>
      [slot({ status: "FullBooked", userIds: token ? [MEMBER.greg, MEMBER.ola] : [] })]);
    const out = await shoot(freshState(), deps(api));
    expect(api.bookClass).toHaveBeenCalledTimes(2);
    expect(api.bookClass).toHaveBeenCalledWith("tok-greg-old", CLASS_ID, 42);
    expect(out.greg!.result).toBe("Booked");
  });

  it("maps confirmation to Booked and Waitlisted", async () => {
    const api = fakeApi();
    api.bookClass.mockImplementation(async (token: string) =>
      token.startsWith("tok-greg") ? { ok: true } : { ok: false, status: 200, early: false });
    api.dailyClasses.mockImplementation(async (_c: number, _d: string, token?: string) =>
      [slot({ status: token ? "Awaitable" : "FullBooked", userIds: token ? [MEMBER.greg] : [] })]);
    const out = await shoot(freshState(), deps(api));
    expect(out).toEqual({
      greg: { date: "2026-10-26", result: "Booked" },
      ola: { date: "2026-10-26", result: "Waitlisted" },
    });
  });

  it("writes outcomes and log lines without secrets", async () => {
    const state = freshState();
    state.users[0]!.tokenExpiresAt = new Date(T.getTime() + 3_600_000).toISOString();
    const api = fakeApi();
    api.bookClass.mockImplementation(async (token: string) =>
      token.startsWith("tok-greg") ? { ok: true } : { ok: false, status: 403, early: false, correlationId: "corr-ola" });
    api.dailyClasses.mockImplementation(async (_c: number, _d: string, token?: string) => [slot({ userIds: token ? [MEMBER.greg] : [] })]);
    const seen: string[] = [];
    const out = await shoot(state, deps(api, (l) => { seen.push(l); fileLog(l); }));

    expect(loadState().snipers[0]!.lastOutcome).toEqual(out);
    expect(out.ola).toEqual({ date: "2026-10-26", result: "Failed", reason: "http 403" });

    const file = readFileSync(join(dir, "data", "logs", "2026-10.log"), "utf8");
    const fileLines = file.trim().split("\n");
    expect(fileLines).toHaveLength(2);
    expect(seen).toHaveLength(2);
    const greg = seen.find((l) => l.includes("user=greg"))!;
    const ola = seen.find((l) => l.includes("user=ola"))!;
    expect(greg).toMatch(/sniper=s1 .*result=Booked/);
    expect(ola).toMatch(/sniper=s1 .*result=Failed.*status=403.*corr=corr-ola/);
    for (const secret of ["tok-greg-old", "tok-greg-new", "tok-ola-old", "pw-greg-SECRET", "pw-ola-SECRET", "greg@example.com", "ola@example.com"]) {
      expect(file).not.toContain(secret);
    }
  });
});
