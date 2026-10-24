import { describe, expect, it } from "vitest";
import type { ClassItem } from "../../api/client.js";
import { matchSlot } from "../match.js";

const cls = (over: Partial<ClassItem>): ClassItem => ({
  id: 1,
  name: "Zumba",
  start: "2026-10-26T18:00:00",
  status: "Bookable",
  userIds: [],
  ...over,
});

describe("matchSlot", () => {
  it("matches by TimeTableId first", () => {
    const byName = cls({ id: 1, timeTableId: 10 });
    const byId = cls({ id: 2, timeTableId: 42, name: "Renamed", start: "2026-10-26T19:00:00" });
    const sniper = { timeTableId: 42, startTime: "18:00", className: "Zumba" };
    expect(matchSlot(sniper, [byName, byId])).toBe(byId);
  });

  it("falls back to start time and name", () => {
    const other = cls({ id: 1, name: "Zumba", start: "2026-10-26T19:00:00" });
    const target = cls({ id: 2, name: "  ZUMBA ", start: "2026-10-26T18:00:00", timeTableId: 7 });
    const sniper = { timeTableId: 99, startTime: "18:00", className: "zumba" };
    expect(matchSlot(sniper, [other, target])).toBe(target);
    expect(matchSlot({ startTime: "18:00", className: " Zumba" }, [other, target])).toBe(target);
  });

  it("returns undefined when the slot is missing", () => {
    const classes = [cls({ name: "Pilates" }), cls({ start: "2026-10-26T18:30:00" })];
    expect(matchSlot({ timeTableId: 5, startTime: "18:00", className: "Zumba" }, classes)).toBeUndefined();
    expect(matchSlot({ startTime: "18:00", className: "Zumba" }, [])).toBeUndefined();
  });
});
