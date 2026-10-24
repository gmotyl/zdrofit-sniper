import type { ClassItem } from "../api/client.js";
import type { Sniper } from "../store/state.js";

const norm = (s: string) => s.trim().toLowerCase();

/** The sniper's class in a day's list: by TimeTableId, else by HH:MM start + name. */
export function matchSlot(
  sniper: Pick<Sniper, "timeTableId" | "startTime" | "className">,
  classes: ClassItem[],
): ClassItem | undefined {
  if (sniper.timeTableId !== undefined) {
    const byId = classes.find((c) => c.timeTableId === sniper.timeTableId);
    if (byId) return byId;
  }
  const name = norm(sniper.className);
  // `start` is club-local "YYYY-MM-DDTHH:MM:SS"; chars 11..16 are HH:MM.
  return classes.find((c) => c.start.slice(11, 16) === sniper.startTime && norm(c.name) === name);
}
