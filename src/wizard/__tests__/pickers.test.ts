import { describe, expect, it, vi } from 'vitest';
import type { ClassItem, Club } from '../../api/client.js';
import { scriptedIo } from '../io.js';
import { pickClub, pickSlot, pickWeekday, toggleUsers } from '../pickers.js';

const CLUBS: Club[] = [
  { id: 42, name: 'Zdrofit Pruszków', city: 'Pruszków' },
  { id: 17, name: 'Zdrofit Wola', city: 'Warszawa' },
  { id: 9, name: 'Zdrofit Galeria', city: 'Pruszków' },
  { id: 5, name: 'Zdrofit Manufaktura', city: 'Łódź' },
];

// Saturday 2026-10-24, 14:00 Warsaw; the next Monday is 2026-10-26.
const NOW = new Date('2026-10-24T12:00:00Z');

function cls(over: Partial<ClassItem>): ClassItem {
  return { id: 1, name: 'Pilates', start: '2026-10-26T18:00:00', status: 'Bookable', userIds: [], ...over };
}

const MONDAY: ClassItem[] = [
  cls({ id: 3, timeTableId: 33, name: 'Tabata', trainer: 'Kasia', start: '2026-10-26T19:00:00' }),
  cls({ id: 1, timeTableId: 11, name: 'Pilates', trainer: 'Ania', start: '2026-10-26T18:00:00' }),
  cls({ id: 2, timeTableId: 22, name: 'Pilates Zdrowy Kręgosłup', trainer: 'Ola', start: '2026-10-26T07:30:00' }),
];

describe('pickers', () => {
  it('filters clubs diacritics-insensitively', async () => {
    for (const filter of ['prusz', 'PRUSZ', 'pruszkow']) {
      const io = scriptedIo([filter, '2']);
      const club = await pickClub(io, CLUBS, CLUBS[1]);
      expect(io.consumed[0]?.prompt).toBe('Klub [Zdrofit Wola] (Enter = ten, albo wpisz filtr) > ');
      // Name or city matches: Pruszków by name, Galeria by city.
      expect(io.printed).toEqual(['1. Zdrofit Pruszków (Pruszków)', '2. Zdrofit Galeria (Pruszków)']);
      expect(club).toEqual(CLUBS[2]);
    }
    // ł has no NFD decomposition; it still matches `lodz`.
    const io = scriptedIo(['lodz', '1']);
    expect(await pickClub(io, CLUBS, CLUBS[1])).toEqual(CLUBS[3]);
    // A new text at the pick prompt re-filters; a bad number re-prompts with a hint.
    const refilter = scriptedIo(['prusz', 'wola', '5', '1']);
    expect(await pickClub(refilter, CLUBS, undefined)).toEqual(CLUBS[1]);
    expect(refilter.printed.filter((l) => /^No club 5/.test(l))).toHaveLength(1);
  });

  it("lists a weekday's slots filtered by name", async () => {
    const dailyClasses = vi.fn(async () => MONDAY);
    const io = scriptedIo(['8', '1', 'pil', '2']);
    const weekday = await pickWeekday(io);
    expect(weekday).toBe(1);
    expect(io.printed.filter((l) => l.startsWith('Weekday'))).toHaveLength(1); // hint for `8`
    io.printed.length = 0;
    const slot = await pickSlot(io, { dailyClasses }, 42, weekday, NOW);
    expect(dailyClasses).toHaveBeenCalledWith(42, '2026-10-26');
    // Sorted by start time, numbered.
    expect(io.printed).toEqual(['1. 07:30  Pilates Zdrowy Kręgosłup · Ola', '2. 18:00  Pilates · Ania']);
    expect(io.consumed.at(-1)?.prompt).toBe('Wybierz slot [lub zmień filtr] > ');
    expect(slot).toEqual(MONDAY[1]);
  });

  it('re-filters slots when text is typed at the slot prompt', async () => {
    const dailyClasses = vi.fn(async () => MONDAY);
    const io = scriptedIo(['', 'tabata', '1']);
    const slot = await pickSlot(io, { dailyClasses }, 42, 1, NOW);
    expect(io.printed).toEqual([
      '1. 07:30  Pilates Zdrowy Kręgosłup · Ola',
      '2. 18:00  Pilates · Ania',
      '3. 19:00  Tabata · Kasia',
      '1. 19:00  Tabata · Kasia',
    ]);
    // Same weekday: one fetch, no new weekday prompt.
    expect(dailyClasses).toHaveBeenCalledTimes(1);
    expect(io.consumed.map((c) => c.prompt)).toEqual([
      'Filtr nazwy (Enter = wszystkie) > ',
      'Wybierz slot [lub zmień filtr] > ',
      'Wybierz slot [lub zmień filtr] > ',
    ]);
    expect(slot).toEqual(MONDAY[0]);
  });

  it('toggles a checklist of users', async () => {
    const users = [{ id: 'greg' }, { id: 'ola' }, { id: 'ewa' }];
    const io = scriptedIo(['2', '9', '1,3', '']);
    const ids = await toggleUsers(io, users, ['greg']);
    expect(io.printed[0]).toBe('[x] 1. greg  [ ] 2. ola  [ ] 3. ewa');
    expect(io.printed[1]).toBe('[x] 1. greg  [x] 2. ola  [ ] 3. ewa');
    expect(io.printed.filter((l) => /^No user 9/.test(l))).toHaveLength(1);
    expect(ids).toEqual(['ola', 'ewa']);
  });
});
