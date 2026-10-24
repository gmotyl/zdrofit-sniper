import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BASE, LoginRefused, bookClass, clubs, dailyClasses, login } from "../client.js";

const fixture = (name: string) =>
  JSON.parse(readFileSync(new URL(`../../../test/fixtures/${name}.json`, import.meta.url), "utf8"));

const loginFx = fixture("login");
const TOKEN: string = loginFx.headers["jwt-token"];
const PASSWORD = "s3cret-Pa55";

type Call = { url: string; init: RequestInit };

function stubFetch(...responses: Response[]) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const res = responses.shift();
    if (!res) throw new Error("unexpected fetch");
    return res;
  });
  vi.stubGlobal("fetch", fn);
  return calls;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("api client", () => {
  it("login reads the token from the jwt-token header and expiry from exp", async () => {
    const calls = stubFetch(json(loginFx.body, 200, loginFx.headers));
    const res = await login("jan.testowy@example.com", PASSWORD);
    expect(res).toEqual({ token: TOKEN, expiresAt: "2026-11-23T07:36:03.000Z", homeClubId: 42, memberId: 900001 });
    expect(calls[0]!.url).toBe(`${BASE}Auth/Login`);
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      RememberMe: true,
      Login: "jan.testowy@example.com",
      Password: PASSWORD,
    });
  });

  it("login throws LoginRefused on non-200 without leaking the password", async () => {
    stubFetch(new Response(`bad password ${PASSWORD}`, { status: 401 }));
    const err = await login("jan.testowy@example.com", PASSWORD).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LoginRefused);
    expect((err as LoginRefused).status).toBe(401);
    expect((err as Error).message).not.toContain(PASSWORD);
    expect(String((err as Error).stack)).not.toContain(PASSWORD);
  });

  it("bookClass maps 499 plain text to an early refusal", async () => {
    const corr = "UTC2026-10-24_08-01_00000000-0000-0000-0000-000000000002";
    const calls = stubFetch(new Response(`Error occured. CorrelationId:"${corr}"`, { status: 499 }));
    const res = await bookClass(TOKEN, 1954156, 42);
    expect(res).toEqual({ ok: false, status: 499, early: true, correlationId: corr });
    expect(calls[0]!.url).toBe(`${BASE}Classes/ClassCalendar/BookClass`);
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ classId: 1954156, clubId: "42" });
  });

  it("bookClass is ok only with Tickets", async () => {
    stubFetch(
      json({ Tickets: [{ Id: 1 }], ClassId: 1954156 }),
      json({ ClassId: 1954156 }),
      new Response("<html>not json</html>", { status: 200, headers: { "pg-correlation-id": "corr-x" } }),
      new Response("boom", { status: 500 }),
    );
    expect(await bookClass(TOKEN, 1954156, 42)).toEqual({ ok: true });
    expect(await bookClass(TOKEN, 1954156, 42)).toEqual({ ok: false, status: 200, early: false });
    expect(await bookClass(TOKEN, 1954156, 42)).toEqual({
      ok: false,
      status: 200,
      early: false,
      correlationId: "corr-x",
    });
    expect(await bookClass(TOKEN, 1954156, 42)).toEqual({ ok: false, status: 500, early: false });
  });

  it("dailyClasses maps fixture fields to ClassItem", async () => {
    const calls = stubFetch(json(fixture("daily")));
    const items = await dailyClasses(42, "2026-10-26", TOKEN);
    expect(items).toEqual([
      {
        id: 1954156,
        timeTableId: 18,
        name: "TBC",
        trainer: "Trener Testowy",
        start: "2026-10-26T16:30:00",
        status: "Unavailable",
        userIds: [],
      },
      {
        id: 1954170,
        timeTableId: 25,
        name: "Zumba",
        trainer: "Trenerka Przykładowa",
        start: "2026-10-26T18:00:00",
        status: "FullBooked",
        userIds: [900001],
      },
    ]);
    expect(calls[0]!.url).toBe(`${BASE}Classes/ClassCalendar/DailyClasses`);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({ clubId: 42, date: "2026-10-26" });
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("clubs maps GetAvailableClassesClubs", async () => {
    const calls = stubFetch(json(fixture("clubs")));
    const list = await clubs();
    expect(list).toEqual([
      { id: 42, name: "Zdrofit Pruszków Sienkiewicza 19 (CH Nowa Stacja)", city: "Pruszków" },
      { id: 7, name: "Zdrofit Warszawa Przykładowa", city: "Warszawa" },
    ]);
    expect(calls[0]!.url).toBe(`${BASE}Clubs/GetAvailableClassesClubs`);
    expect(calls[0]!.init.method).toBe("GET");
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBeUndefined();
  });
});
