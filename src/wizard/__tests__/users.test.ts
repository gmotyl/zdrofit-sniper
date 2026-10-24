import { describe, expect, it, vi } from 'vitest';
import { LoginRefused, type Club, type Session } from '../../api/client.js';
import type { Sniper, State } from '../../store/state.js';
import { scriptedIo } from '../io.js';
import { usersScreen, type UsersDeps } from '../users.js';

const CLUBS: Club[] = [
  { id: 42, name: 'Zdrofit Pruszków', city: 'Pruszków' },
  { id: 17, name: 'Zdrofit Wola', city: 'Warszawa' },
];

function session(over: Partial<Session> = {}): Session {
  return { token: 'tok-new', expiresAt: '2026-11-01T00:00:00Z', homeClubId: 17, memberId: 999, ...over };
}

function sniper(over: Partial<Sniper> = {}): Sniper {
  return {
    id: 's1', active: true, clubId: 42, clubName: 'Zdrofit Pruszków', weekday: 1, startTime: '18:00',
    className: 'Pilates', userIds: [], ...over,
  };
}

function baseState(): State {
  return {
    users: [
      { id: 'greg', email: 'greg@example.com', password: 'old-greg', token: 'tok-greg', tokenExpiresAt: '2026-10-30T00:00:00Z', homeClubId: 42, memberId: 1 },
      { id: 'ola', email: 'ola@example.com', password: 'old-ola', token: 'tok-ola', tokenExpiresAt: '2026-10-30T00:00:00Z', homeClubId: 99, memberId: 2 },
    ],
    snipers: [
      sniper({ id: 's1', userIds: ['greg', 'ola'], lastOutcome: { greg: { date: '2026-10-19', result: 'Booked' }, ola: { date: '2026-10-19', result: 'Failed', reason: 'login' } } }),
      sniper({ id: 's2', userIds: ['ola'] }),
      sniper({ id: 's3', userIds: ['greg'] }),
    ],
  };
}

function deps(answers: string[], login: UsersDeps['api']['login']) {
  const io = scriptedIo(answers);
  const saved: State[] = [];
  const d: UsersDeps = {
    io,
    api: { login: vi.fn(login), clubs: vi.fn(async () => CLUBS) },
    save: (s) => {
      saved.push(structuredClone(s));
    },
  };
  return { io, saved, d };
}

function noSecrets(lines: string[], secrets: string[]) {
  for (const line of lines) for (const s of secrets) expect(line).not.toContain(s);
}

describe('usersScreen', () => {
  it('renders the list as `n. id  (email, home club <name>)`', async () => {
    const { io, d } = deps(['0'], async () => session());
    await usersScreen(baseState(), d);
    expect(io.printed).toContain('1. greg  (greg@example.com, home club Zdrofit Pruszków)');
    // Unknown club id falls back to the id.
    expect(io.printed).toContain('2. ola  (ola@example.com, home club 99)');
    expect(io.printed).toContain('A - add · nB - remove · nC - change password · 0 - back');
  });

  it('falls back to club ids when the club list cannot be fetched', async () => {
    const { io, d } = deps(['0'], async () => session());
    d.api.clubs = vi.fn(async () => {
      throw new Error('clubs failed (HTTP 500)');
    });
    await usersScreen(baseState(), d);
    expect(io.printed).toContain('1. greg  (greg@example.com, home club 42)');
  });

  it('adds a user after a successful login test', async () => {
    const { io, saved, d } = deps(['A', 'Ewa.K@example.com', 's3cret', '0'], async () => session());
    const result = await usersScreen(baseState(), d);
    expect(d.api.login).toHaveBeenCalledWith('Ewa.K@example.com', 's3cret');
    expect(saved).toHaveLength(1);
    const added = { id: 'ewak', email: 'Ewa.K@example.com', password: 's3cret', token: 'tok-new', tokenExpiresAt: '2026-11-01T00:00:00Z', homeClubId: 17, memberId: 999 };
    expect(saved[0]?.users[2]).toEqual(added);
    expect(result.users[2]).toEqual(added);
    // The redrawn list shows the new user with their home club name.
    expect(io.printed).toContain('3. ewak  (Ewa.K@example.com, home club Zdrofit Wola)');
    noSecrets(io.printed, ['s3cret', 'tok-new']);
  });

  it('does not save when login is refused', async () => {
    const before = baseState();
    const { io, saved, d } = deps(['A', 'ewa@example.com', 'wrong', '0'], async () => {
      throw new LoginRefused(401);
    });
    const result = await usersScreen(before, d);
    expect(saved).toHaveLength(0);
    expect(result).toEqual(baseState());
    expect(before).toEqual(baseState());
    const errors = io.printed.filter((l) => /refused/i.test(l));
    expect(errors).toHaveLength(1);
    noSecrets(io.printed, ['wrong']);
  });

  it('asks for the password without echo', async () => {
    const { io, d } = deps(['A', 'ewa@example.com', 'pw', '1C', 'pw2', '0'], async () => session());
    await usersScreen(baseState(), d);
    const methods = io.consumed.map((c) => [c.method, c.answer]);
    expect(methods).toContainEqual(['askHidden', 'pw']);
    expect(methods).toContainEqual(['askHidden', 'pw2']);
    expect(io.consumed.filter((c) => c.method === 'ask').map((c) => c.answer)).not.toContain('pw');
    expect(io.consumed.filter((c) => c.method === 'ask').map((c) => c.answer)).not.toContain('pw2');
  });

  it('removing a user drops them from every sniper', async () => {
    const { saved, d } = deps(['2B', '0'], async () => session());
    const result = await usersScreen(baseState(), d);
    expect(saved).toHaveLength(1);
    expect(result.users.map((u) => u.id)).toEqual(['greg']);
    expect(result.snipers.map((s) => s.userIds)).toEqual([['greg'], [], ['greg']]);
    expect(result.snipers[0]?.lastOutcome).toEqual({ greg: { date: '2026-10-19', result: 'Booked' } });
    expect(saved[0]).toEqual(result);
  });

  it('changes a password only when the new one logs in', async () => {
    let accept = false;
    const { io, saved, d } = deps(['1C', 'bad-pw', '1C', 'good-pw', '0'], async () => {
      if (!accept) {
        accept = true;
        throw new LoginRefused(401);
      }
      return session({ token: 'tok-fresh', expiresAt: '2026-12-01T00:00:00Z' });
    });
    const result = await usersScreen(baseState(), d);
    expect(d.api.login).toHaveBeenNthCalledWith(1, 'greg@example.com', 'bad-pw');
    expect(d.api.login).toHaveBeenNthCalledWith(2, 'greg@example.com', 'good-pw');
    // Only the accepted change was saved.
    expect(saved).toHaveLength(1);
    expect(result.users[0]).toMatchObject({ password: 'good-pw', token: 'tok-fresh', tokenExpiresAt: '2026-12-01T00:00:00Z' });
    expect(result.users[1]).toEqual(baseState().users[1]);
    noSecrets(io.printed, ['bad-pw', 'good-pw', 'tok-fresh', 'old-greg', 'tok-greg']);
  });

  it('re-prompts with a hint on invalid input', async () => {
    const { io, saved, d } = deps(['5B', 'x', '0'], async () => session());
    await usersScreen(baseState(), d);
    expect(saved).toHaveLength(0);
    expect(io.printed.filter((l) => l.startsWith('No item 5.'))).toHaveLength(1);
    expect(io.consumed.filter((c) => c.method === 'ask')).toHaveLength(3);
  });
});
