import type { ClassItem, Club } from '../api/client.js';
import type { Weekday } from '../schedule/opening.js';
import type { Outcome, Sniper, State } from '../store/state.js';
import type { Io } from './io.js';
import { parseChoice } from './menu.js';
import { pickClub, pickSlot, pickUsers, pickWeekday, toggleUsers } from './pickers.js';

export interface SnipersDeps {
  io: Io;
  api: {
    clubs(): Promise<Club[]>;
    dailyClasses(clubId: number, date: string): Promise<ClassItem[]>;
  };
  /** Persists the new state; the CLI also restarts the daemon here. Called only after a finished change. */
  save(state: State): void | Promise<void>;
  /** Clock for the listed weekday date; defaults to the real one. */
  now?(): Date;
}

export const SNIPERS_ACTIONS = 'A - add · nB - remove · nC - users · nD - activate/deactivate · 0 - back';

const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** Snipers screen loop. Never mutates `state`; returns the last saved state when the user goes back. */
export async function snipersScreen(state: State, deps: SnipersDeps): Promise<State> {
  const { io } = deps;
  let current = state;

  const commit = async (next: State): Promise<void> => {
    await deps.save(next);
    current = next;
  };
  const replace = (s: State, sniper: Sniper): State => ({
    ...s,
    snipers: s.snipers.map((x) => (x.id === sniper.id ? sniper : x)),
  });

  for (;;) {
    io.print('');
    io.print('Snipers');
    if (current.snipers.length === 0) io.print('(no snipers yet)');
    current.snipers.forEach((s, i) => io.print(sniperLine(i + 1, s)));
    io.print(SNIPERS_ACTIONS);

    const choice = parseChoice(await io.ask('> '), current.snipers.length, ['B', 'C', 'D'], ['A']);
    if (choice.kind === 'back') return current;
    if (choice.kind === 'invalid') {
      io.print(choice.hint);
      continue;
    }
    if (choice.kind === 'list') {
      const next = await addSniper(current, deps);
      if (next) await commit(next);
      continue;
    }
    const sniper = current.snipers[choice.index - 1] as Sniper;
    if (choice.action === 'B') {
      await commit({ ...current, snipers: current.snipers.filter((s) => s.id !== sniper.id) });
      io.print(`Removed sniper ${choice.index}.`);
    } else if (choice.action === 'D') {
      await commit(replace(current, { ...sniper, active: !sniper.active }));
    } else {
      const userIds = await toggleUsers(io, current.users, sniper.userIds);
      const unchanged = userIds.length === sniper.userIds.length && userIds.every((id, i) => id === sniper.userIds[i]);
      if (!unchanged) await commit(replace(current, { ...sniper, userIds }));
    }
  }
}

export function sniperLine(n: number, s: Sniper): string {
  const users = s.userIds.length > 0 ? s.userIds.join(', ') : '—';
  return (
    `${n}. [${s.active ? 'ON ' : 'OFF'}] ${s.clubName} (${s.clubId}) · ${DAYS[s.weekday - 1]} ${s.startTime}` +
    ` · ${s.className} · ${users} · last: ${lastSummary(s)}`
  );
}

/** `Booked 2026-10-19` when every user got the same result, else per user: `greg Booked, ola Failed 2026-10-19`. */
export function lastSummary(s: Sniper): string {
  const entries = Object.entries(s.lastOutcome ?? {}) as [string, Outcome][];
  if (entries.length === 0) return '—';
  const date = entries.map(([, o]) => o.date).sort().at(-1) as string;
  const results = new Set(entries.map(([, o]) => o.result));
  if (results.size === 1) return `${entries[0]![1].result} ${date}`;
  // Sniper order first, then users no longer on it.
  const order = (id: string) => {
    const i = s.userIds.indexOf(id);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  entries.sort(([a], [b]) => order(a) - order(b));
  return `${entries.map(([id, o]) => `${id} ${o.result}`).join(', ')} ${date}`;
}

function nextSniperId(snipers: Sniper[]): string {
  let n = snipers.length + 1;
  while (snipers.some((s) => s.id === `s${n}`)) n++;
  return `s${n}`;
}

/** Add flow; returns the next state, or undefined (with a printed reason) when nothing is to be saved. */
async function addSniper(state: State, deps: SnipersDeps): Promise<State | undefined> {
  const { io } = deps;
  if (state.users.length === 0) {
    io.print('No users yet — add a user first (manage users).');
    return undefined;
  }
  let clubs: Club[];
  try {
    clubs = await deps.api.clubs();
  } catch (err) {
    io.print(`Cannot list clubs: ${(err as Error).message} — nothing saved.`);
    return undefined;
  }
  const defaultId = state.lastClubId ?? (state.users[0] as { homeClubId: number }).homeClubId;
  const fallback = clubs.find((c) => c.id === defaultId) ?? { id: defaultId, name: String(defaultId), city: '' };

  const club = await pickClub(io, clubs, fallback);
  const weekday: Weekday = await pickWeekday(io);
  const slot = await pickSlot(io, deps.api, club.id, weekday, deps.now?.() ?? new Date());
  if (!slot) return undefined;
  const userIds = await pickUsers(io, state.users);

  const sniper: Sniper = {
    id: nextSniperId(state.snipers),
    active: true,
    clubId: club.id,
    clubName: club.name,
    weekday,
    // `start` is club-local "YYYY-MM-DDTHH:MM:SS".
    startTime: slot.start.slice(11, 16),
    className: slot.name,
    ...(slot.timeTableId !== undefined ? { timeTableId: slot.timeTableId } : {}),
    userIds,
  };
  io.print(`Added sniper ${sniper.id}.`);
  return { ...state, snipers: [...state.snipers, sniper], lastClubId: club.id };
}
