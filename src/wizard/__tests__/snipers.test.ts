import { describe, expect, it, vi } from 'vitest';
import type { ClassItem, Club } from '../../api/client.js';
import type { Sniper, State } from '../../store/state.js';
import { scriptedIo } from '../io.js';
import { SNIPERS_ACTIONS, snipersScreen, type SnipersDeps } from '../snipers.js';

const CLUBS: Club[] = [
  { id: 42, name: 'Zdrofit Pruszków', city: 'Pruszków' },
  { id: 17, name: 'Zdrofit Wola', city: 'Warszawa' },
  { id: 99, name: 'Zdrofit Ursus', city: 'Warszawa' },
];

// Saturday 2026-10-24; the next Monday is 2026-10-26.
const NOW = new Date('2026-10-24T12:00:00Z');

const MONDAY: ClassItem[] = [
  { id: 1, timeTableId: 11, name: 'Pilates', trainer: 'Ania', start: '2026-10-26T18:00:00', status: 'Bookable', userIds: [] },
  { id: 3, timeTableId: 33, name: 'Tabata', trainer: 'Kasia', start: '2026-10-26T19:00:00', status: 'Bookable', userIds: [] },
];

function sniper(over: Partial<Sniper> = {}): Sniper {
  return {
    id: 's1', active: true, clubId: 42, clubName: 'Zdrofit Pruszków', weekday: 1, startTime: '18:00',
    className: 'Pilates', userIds: ['greg'], ...over,
  };
}

function baseState(): State {
  return {
    users: [
      { id: 'greg', email: 'greg@example.com', password: 'pw-greg', homeClubId: 99 },
      { id: 'ola', email: 'ola@example.com', password: 'pw-ola', homeClubId: 42 },
    ],
    snipers: [
      sniper({
        id: 's1', userIds: ['greg', 'ola'],
        lastOutcome: { greg: { date: '2026-10-19', result: 'Booked' }, ola: { date: '2026-10-19', result: 'Booked' } },
      }),
      sniper({ id: 's2', active: false, clubId: 17, clubName: 'Zdrofit Wola', weekday: 4, startTime: '07:00', className: 'BodyPump' }),
    ],
  };
}

function deps(answers: string[]) {
  const io = scriptedIo(answers);
  const saved: State[] = [];
  const d: SnipersDeps = {
    io,
    api: { clubs: vi.fn(async () => CLUBS), dailyClasses: vi.fn(async () => MONDAY) },
    save: (s) => {
      saved.push(structuredClone(s));
    },
    now: () => NOW,
  };
  return { io, saved, d };
}

describe('snipersScreen', () => {
  it('renders the sniper list with status and last outcome', async () => {
    const { io, d } = deps(['0']);
    await snipersScreen(baseState(), d);
    expect(io.printed).toContain('1. [ON ] Zdrofit Pruszków (42) · Mon 18:00 · Pilates · greg, ola · last: Booked 2026-10-19');
    expect(io.printed).toContain('2. [OFF] Zdrofit Wola (17) · Thu 07:00 · BodyPump · greg · last: —');
    expect(io.printed).toContain(SNIPERS_ACTIONS);
    expect(SNIPERS_ACTIONS).toBe('A - add · nB - remove · nC - users · nD - activate/deactivate · 0 - back');
  });

  it('defaults the club to the last used one', async () => {
    // lastClubId wins over the first user's home club.
    const withLast = deps(['A', '', '1', '', '1', '1', '0']);
    const a = await snipersScreen({ ...baseState(), lastClubId: 17 }, withLast.d);
    expect(withLast.io.consumed[1]?.prompt).toBe('Klub [Zdrofit Wola] (Enter = ten, albo wpisz filtr) > ');
    expect(a.snipers[2]).toMatchObject({ clubId: 17, clubName: 'Zdrofit Wola' });
    expect(withLast.d.api.dailyClasses).toHaveBeenCalledWith(17, '2026-10-26');

    // No lastClubId: the first user's home club.
    const noLast = deps(['A', '', '1', '', '1', '1', '0']);
    const b = await snipersScreen(baseState(), noLast.d);
    expect(noLast.io.consumed[1]?.prompt).toBe('Klub [Zdrofit Ursus] (Enter = ten, albo wpisz filtr) > ');
    expect(b.snipers[2]).toMatchObject({ clubId: 99, clubName: 'Zdrofit Ursus' });
  });

  it('saves a new active sniper with ordered users', async () => {
    const before = baseState();
    const { io, saved, d } = deps(['A', 'prusz', '1', '1', 'tab', '1', '2,1', '0']);
    const result = await snipersScreen(before, d);
    expect(saved).toHaveLength(1);
    const added = {
      id: 's3', active: true, clubId: 42, clubName: 'Zdrofit Pruszków', weekday: 1, startTime: '19:00',
      className: 'Tabata', timeTableId: 33, userIds: ['ola', 'greg'],
    };
    expect(saved[0]?.snipers[2]).toEqual(added);
    expect(Object.keys(saved[0]!.snipers[2]!)).toEqual(Object.keys(added));
    expect(saved[0]?.lastClubId).toBe(42);
    expect(result).toEqual(saved[0]);
    expect(before).toEqual(baseState());
    expect(io.printed).toContain('1. greg');
    expect(io.printed).toContain('2. ola');
    expect(io.printed).toContain('3. [ON ] Zdrofit Pruszków (42) · Mon 19:00 · Tabata · ola, greg · last: —');
  });

  it('rejects invalid user lists and refuses to add without users', async () => {
    const { io, saved, d } = deps(['A', '', '1', '', '1', '3', '', '1,x', '1', '0']);
    const result = await snipersScreen(baseState(), d);
    expect(saved).toHaveLength(1);
    expect(result.snipers[2]?.userIds).toEqual(['greg']);
    expect(io.printed.filter((l) => l.startsWith('Use numbers'))).toHaveLength(3);

    const empty = deps(['A', '0']);
    const out = await snipersScreen({ users: [], snipers: [] }, empty.d);
    expect(empty.saved).toHaveLength(0);
    expect(out).toEqual({ users: [], snipers: [] });
    expect(empty.io.printed.some((l) => /add a user first/i.test(l))).toBe(true);
  });

  it('toggles users on an existing sniper', async () => {
    // s2's users differ from s1's post-toggle value, so a toggle leaking into s2 shows.
    const before = baseState();
    before.snipers[1]!.userIds = ['ola'];
    const { io, saved, d } = deps(['1C', '2', '', '0']);
    const result = await snipersScreen(before, d);
    expect(io.printed).toContain('[x] 1. greg  [x] 2. ola');
    expect(saved).toHaveLength(1);
    const expected = structuredClone(before);
    expected.snipers[0]!.userIds = ['greg'];
    expect(result.snipers[1]).toEqual(before.snipers[1]);
    expect(result).toEqual(expected);
    expect(saved[0]).toEqual(expected);
  });

  it('removes and activates snipers', async () => {
    // D runs while both snipers exist, so a D that flips every sniper shows on s2.
    const { saved, d } = deps(['1D', '2B', '9D', '0']);
    const result = await snipersScreen(baseState(), d);
    expect(saved).toHaveLength(2);
    expect(saved[0]?.snipers).toEqual([{ ...baseState().snipers[0], active: false }, baseState().snipers[1]]);
    expect(saved[1]?.snipers).toEqual([{ ...baseState().snipers[0], active: false }]);
    expect(result).toEqual(saved[1]);
  });
});
