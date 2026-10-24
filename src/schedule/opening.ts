export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7; // ISO, 1 = Monday
export interface SlotTime { weekday: Weekday; startTime: string /* "HH:MM" Warsaw */ }
export interface Occurrence { date: string /* YYYY-MM-DD */; start: Date; opening: Date }

const ZONE = "Europe/Warsaw";
const DAY_MS = 86_400_000;
const OPENING_DAYS_BEFORE = 2;

// Explicit zone, so results never depend on process.env.TZ.
const warsawParts = new Intl.DateTimeFormat("en-US", {
  timeZone: ZONE,
  hourCycle: "h23",
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
});

/** Warsaw wall clock of an instant, encoded as a UTC epoch (ms precision dropped to seconds). */
function warsawWallMs(instant: number): number {
  const p: Record<string, number> = {};
  for (const { type, value } of warsawParts.formatToParts(instant)) p[type] = Number(value);
  return Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!);
}

/** Instant at which the Warsaw wall clock shows `wallMs` (a UTC-encoded wall time). */
function warsawInstant(wallMs: number): Date {
  // Two passes settle the offset; across a DST edge the second pass corrects the first guess.
  let instant = wallMs - (warsawWallMs(wallMs) - wallMs);
  instant = wallMs - (warsawWallMs(instant) - instant);
  return new Date(instant);
}

/** Calendar day (UTC-encoded midnight) of a Warsaw wall time. */
function dayOf(wallMs: number): number {
  return Math.floor(wallMs / DAY_MS) * DAY_MS;
}

function isoWeekday(dayMs: number): Weekday {
  return (((new Date(dayMs).getUTCDay() + 6) % 7) + 1) as Weekday;
}

/** Earliest occurrence of the slot whose opening is strictly after `now`. */
export function nextOccurrence(slot: SlotTime, now: Date): Occurrence {
  const [hh, mm] = slot.startTime.split(":").map(Number);
  const timeMs = (hh! * 60 + mm!) * 60_000;
  const today = dayOf(warsawWallMs(now.getTime()));

  // Earlier occurrences open at least two days before today, so start from this week's.
  let day = today + ((slot.weekday - isoWeekday(today) + 7) % 7) * DAY_MS;
  for (;;) {
    const opening = warsawInstant(day - OPENING_DAYS_BEFORE * DAY_MS + timeMs);
    if (opening.getTime() > now.getTime()) {
      return {
        date: new Date(day).toISOString().slice(0, 10),
        start: warsawInstant(day + timeMs),
        opening,
      };
    }
    day += 7 * DAY_MS;
  }
}
