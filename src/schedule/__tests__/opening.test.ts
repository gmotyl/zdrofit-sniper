import { afterEach, describe, expect, it } from "vitest";
import { nextOccurrence, type SlotTime } from "../opening.js";

// Warsaw is UTC+2 (CEST) until 2026-10-25 and from 2027-03-28, UTC+1 (CET) in between.
const monday18: SlotTime = { weekday: 1, startTime: "18:00" };
const monday08: SlotTime = { weekday: 1, startTime: "08:00" };

describe("nextOccurrence", () => {
  const originalTz = process.env.TZ;
  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it("opening is the same wall-clock time two calendar days earlier", () => {
    // Fri 2026-10-23 12:00 Warsaw (CEST)
    const occ = nextOccurrence(monday18, new Date("2026-10-23T10:00:00Z"));
    expect(occ.date).toBe("2026-10-26");
    expect(occ.start.toISOString()).toBe("2026-10-26T17:00:00.000Z"); // 18:00 CET
    expect(occ.opening.toISOString()).toBe("2026-10-24T16:00:00.000Z"); // Sat 18:00 CEST
  });

  it("opening across the October DST switch uses the wall clock", () => {
    const occ = nextOccurrence(monday08, new Date("2026-10-23T10:00:00Z"));
    expect(occ.date).toBe("2026-10-26");
    expect(occ.start.toISOString()).toBe("2026-10-26T07:00:00.000Z"); // 08:00 CET
    expect(occ.opening.toISOString()).toBe("2026-10-24T06:00:00.000Z"); // Sat 08:00 CEST, 49 h earlier
  });

  it("opening across the March DST switch uses the wall clock", () => {
    // Fri 2027-03-26 12:00 Warsaw (CET); clocks go forward Sun 2027-03-28
    const occ = nextOccurrence(monday08, new Date("2027-03-26T11:00:00Z"));
    expect(occ.date).toBe("2027-03-29");
    expect(occ.start.toISOString()).toBe("2027-03-29T06:00:00.000Z"); // 08:00 CEST
    expect(occ.opening.toISOString()).toBe("2027-03-27T07:00:00.000Z"); // Sat 08:00 CET, 47 h earlier
  });

  it("skips to next week when this week's opening has passed", () => {
    // Exactly at this week's opening (Sat 2026-10-24 18:00 CEST): opening must be strictly after now
    for (const now of ["2026-10-24T16:00:00Z", "2026-10-24T16:01:00Z", "2026-10-26T18:00:00Z"]) {
      const occ = nextOccurrence(monday18, new Date(now));
      expect(occ.date).toBe("2026-11-02");
      expect(occ.start.toISOString()).toBe("2026-11-02T17:00:00.000Z");
      expect(occ.opening.toISOString()).toBe("2026-10-31T17:00:00.000Z");
    }
    // One minute before the opening still targets this week
    expect(nextOccurrence(monday18, new Date("2026-10-24T15:59:00Z")).date).toBe("2026-10-26");
  });

  it("result does not depend on the process time zone", () => {
    const cases: Array<[SlotTime, string]> = [
      [monday18, "2026-10-23T10:00:00Z"],
      [monday08, "2026-10-23T10:00:00Z"],
      [monday08, "2027-03-26T11:00:00Z"],
      [{ weekday: 7, startTime: "23:30" }, "2026-10-24T22:30:00Z"],
      [{ weekday: 6, startTime: "00:15" }, "2026-10-23T23:00:00Z"],
    ];
    const run = () =>
      cases.map(([slot, now]) => {
        const o = nextOccurrence(slot, new Date(now));
        return [o.date, o.start.toISOString(), o.opening.toISOString()];
      });

    process.env.TZ = "Europe/Warsaw";
    const warsaw = run();
    const offsets = new Set<number>();
    for (const tz of ["UTC", "America/New_York", "Asia/Tokyo"]) {
      process.env.TZ = tz;
      offsets.add(new Date("2026-07-01T00:00:00Z").getTimezoneOffset());
      expect(run()).toEqual(warsaw);
    }
    // Guard: the runtime TZ switch actually took effect
    expect(offsets.size).toBe(3);
  });
});
