import type { ClassItem, Club } from '../api/client.js';
import { nextOccurrence, type Weekday } from '../schedule/opening.js';
import type { Io } from './io.js';

/** Lowercase, diacritics stripped (`Łódź` → `lodz`) for filter matching. */
export function fold(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/ł/g, 'l')
    .replace(/Ł/g, 'L')
    .toLowerCase()
    .trim();
}

/** Clubs whose name or city contains the filter, case- and diacritics-insensitive. */
export function filterClubs(clubs: Club[], filter: string): Club[] {
  const f = fold(filter);
  return clubs.filter((c) => fold(c.name).includes(f) || fold(c.city).includes(f));
}

/** Parses a 1-based list number; undefined unless it is a whole number within 1..count. */
function listNumber(text: string, count: number): number | undefined {
  if (!/^\d+$/.test(text)) return undefined;
  const n = Number(text);
  return n >= 1 && n <= count ? n : undefined;
}

/**
 * Club prompt: Enter takes `fallback`; any other text filters into a numbered list,
 * picked by number at a follow-up prompt that also accepts a new filter.
 */
export async function pickClub(io: Io, clubs: Club[], fallback: Club | undefined): Promise<Club> {
  const first = fallback
    ? `Klub [${fallback.name}] (Enter = ten, albo wpisz filtr) > `
    : 'Klub (wpisz filtr) > ';
  let filter = (await io.ask(first)).trim();
  for (;;) {
    if (filter === '') {
      if (fallback) return fallback;
      io.print('Type part of a club name or city.');
      filter = (await io.ask(first)).trim();
      continue;
    }
    const matches = filterClubs(clubs, filter);
    if (matches.length === 0) {
      io.print(`No club matches "${filter}".`);
      filter = (await io.ask(first)).trim();
      continue;
    }
    matches.forEach((c, i) => io.print(`${i + 1}. ${c.name} (${c.city})`));
    for (;;) {
      const answer = (await io.ask('Wybierz klub [lub zmień filtr] > ')).trim();
      if (/^\d+$/.test(answer)) {
        const n = listNumber(answer, matches.length);
        if (n !== undefined) return matches[n - 1] as Club;
        io.print(`No club ${answer}. Use 1-${matches.length} or type a new filter.`);
        continue;
      }
      filter = answer;
      break;
    }
  }
}

/** ISO weekday 1-7, 1 = Monday. */
export async function pickWeekday(io: Io): Promise<Weekday> {
  for (;;) {
    const answer = (await io.ask('Dzień tygodnia (1 = pon … 7 = nd) > ')).trim();
    const n = listNumber(answer, 7);
    if (n !== undefined) return n as Weekday;
    io.print('Weekday must be 1-7 (1 = Monday).');
  }
}

/**
 * The date whose classes are listed: the next such weekday whose latest-possible slot
 * still opens in the future, i.e. the first occurrence a new sniper could target.
 */
export function listingDate(weekday: Weekday, now: Date): string {
  return nextOccurrence({ weekday, startTime: '23:59' }, now).date;
}

export function slotLine(n: number, c: ClassItem): string {
  return `${n}. ${c.start.slice(11, 16)}  ${c.name}${c.trainer ? ` · ${c.trainer}` : ''}`;
}

/**
 * Lists one weekday's classes filtered by name and picks one by number; any other text at
 * the slot prompt re-filters the same day (fetched once). Undefined when the day cannot be listed.
 */
export async function pickSlot(
  io: Io,
  api: { dailyClasses(clubId: number, date: string): Promise<ClassItem[]> },
  clubId: number,
  weekday: Weekday,
  now: Date,
): Promise<ClassItem | undefined> {
  const date = listingDate(weekday, now);
  let classes: ClassItem[];
  try {
    classes = await api.dailyClasses(clubId, date);
  } catch (err) {
    io.print(`Cannot list classes for ${date}: ${(err as Error).message} — nothing saved.`);
    return undefined;
  }
  if (classes.length === 0) {
    io.print(`No classes on ${date} — nothing saved.`);
    return undefined;
  }
  const sorted = [...classes].sort((a, b) => a.start.localeCompare(b.start));
  // undefined: keep the current list without reprinting it.
  let filter: string | undefined = (await io.ask('Filtr nazwy (Enter = wszystkie) > ')).trim();
  let shown: ClassItem[] = [];
  for (;;) {
    if (filter !== undefined) {
      const f = fold(filter);
      shown = sorted.filter((c) => fold(c.name).includes(f));
      if (shown.length === 0) io.print(`No class matches "${filter}" on ${date}. Type another filter (Enter = all).`);
      shown.forEach((c, i) => io.print(slotLine(i + 1, c)));
    }
    const answer = (await io.ask('Wybierz slot [lub zmień filtr] > ')).trim();
    if (/^\d+$/.test(answer)) {
      const n = listNumber(answer, shown.length);
      if (n !== undefined) return shown[n - 1];
      io.print(`No slot ${answer}. Use 1-${shown.length} or type a new filter.`);
      filter = undefined;
      continue;
    }
    filter = answer;
  }
}

/**
 * Comma-separated list numbers (`1,2`) to ids, in the typed order. Undefined on an empty,
 * malformed, out-of-range or repeated entry.
 */
export function parseNumbers(text: string, count: number): number[] | undefined {
  const parts = text.split(',').map((p) => p.trim());
  const nums = parts.map((p) => listNumber(p, count));
  if (nums.some((n) => n === undefined) || new Set(nums).size !== nums.length) return undefined;
  return nums as number[];
}

/** Numbered user list; comma-separated numbers choose the users in that order. */
export async function pickUsers(io: Io, users: { id: string }[]): Promise<string[]> {
  users.forEach((u, i) => io.print(`${i + 1}. ${u.id}`));
  for (;;) {
    const nums = parseNumbers(await io.ask('Użytkownicy (np. 1,2) > '), users.length);
    if (nums) return nums.map((n) => (users[n - 1] as { id: string }).id);
    io.print(`Use numbers 1-${users.length}, comma-separated, e.g. 1,2.`);
  }
}

function checklist(users: { id: string }[], selected: string[]): string {
  return users.map((u, i) => `[${selected.includes(u.id) ? 'x' : ' '}] ${i + 1}. ${u.id}`).join('  ');
}

/**
 * Checklist `[x] 1. greg  [ ] 2. ola`: numbers toggle, Enter returns the selection.
 * Kept users stay in their order; newly ticked ones are appended.
 */
export async function toggleUsers(io: Io, users: { id: string }[], selected: string[]): Promise<string[]> {
  let current = [...selected];
  io.print(checklist(users, current));
  for (;;) {
    const answer = (await io.ask('Przełącz numery (Enter = zapisz) > ')).trim();
    if (answer === '') return current;
    const nums = parseNumbers(answer, users.length);
    if (!nums) {
      io.print(`No user ${answer}. Use numbers 1-${users.length}, comma-separated; Enter saves.`);
      continue;
    }
    for (const n of nums) {
      const id = (users[n - 1] as { id: string }).id;
      current = current.includes(id) ? current.filter((x) => x !== id) : [...current, id];
    }
    io.print(checklist(users, current));
  }
}
