import { LoginRefused, type Club, type Session } from '../api/client.js';
import { userIdFromEmail, type State, type User } from '../store/state.js';
import type { Io } from './io.js';
import { parseChoice } from './menu.js';

export interface UsersDeps {
  io: Io;
  api: {
    login(email: string, password: string): Promise<Session>;
    clubs(): Promise<Club[]>;
  };
  /** Persists the new state; the CLI also restarts the daemon here. Called only after a finished change. */
  save(state: State): void | Promise<void>;
}

export const USERS_ACTIONS = 'A - add · nB - remove · nC - change password · 0 - back';

/**
 * Users screen loop. Never mutates `state`; returns the last saved state when the user goes back.
 * Passwords and tokens are never printed.
 */
export async function usersScreen(state: State, deps: UsersDeps): Promise<State> {
  const { io } = deps;
  const clubNames = await loadClubNames(deps);
  let current = state;

  const commit = async (next: State): Promise<void> => {
    await deps.save(next);
    current = next;
  };

  for (;;) {
    io.print('');
    io.print('Users');
    if (current.users.length === 0) io.print('(no users yet)');
    current.users.forEach((u, i) => io.print(userLine(i + 1, u, clubNames)));
    io.print(USERS_ACTIONS);

    const choice = parseChoice(await io.ask('> '), current.users.length, ['B', 'C'], ['A']);
    if (choice.kind === 'back') return current;
    if (choice.kind === 'invalid') {
      io.print(choice.hint);
      continue;
    }
    if (choice.kind === 'list') {
      const user = await addUser(current, deps);
      if (user) await commit({ ...current, users: [...current.users, user] });
      continue;
    }
    const user = current.users[choice.index - 1] as User;
    if (choice.action === 'B') {
      await commit(removeUser(current, user.id));
      io.print(`Removed ${user.id}.`);
    } else {
      const updated = await changePassword(user, deps);
      if (updated) await commit({ ...current, users: current.users.map((u) => (u.id === user.id ? updated : u)) });
    }
  }
}

function userLine(n: number, u: User, clubNames: Map<number, string>): string {
  return `${n}. ${u.id}  (${u.email}, home club ${clubNames.get(u.homeClubId) ?? u.homeClubId})`;
}

async function loadClubNames(deps: UsersDeps): Promise<Map<number, string>> {
  try {
    return new Map((await deps.api.clubs()).map((c) => [c.id, c.name]));
  } catch {
    // Names are cosmetic; the list falls back to club ids.
    return new Map();
  }
}

/** Runs a login test; prints exactly one error line on failure and returns undefined. */
async function tryLogin(email: string, password: string, deps: UsersDeps): Promise<Session | undefined> {
  try {
    return await deps.api.login(email, password);
  } catch (err) {
    // Client errors never carry credentials, so the message is safe to show.
    const reason = err instanceof LoginRefused ? `Login refused (HTTP ${err.status})` : `Login failed: ${(err as Error).message}`;
    deps.io.print(`${reason} — nothing saved.`);
    return undefined;
  }
}

async function addUser(state: State, deps: UsersDeps): Promise<User | undefined> {
  const email = (await deps.io.ask('E-mail: ')).trim();
  if (email === '') {
    deps.io.print('No e-mail given — nothing saved.');
    return undefined;
  }
  if (state.users.some((u) => u.email.toLowerCase() === email.toLowerCase())) {
    deps.io.print(`${email} is already a user — nothing saved.`);
    return undefined;
  }
  const password = await deps.io.askHidden('Password: ');
  const session = await tryLogin(email, password, deps);
  if (!session) return undefined;
  const user: User = {
    id: userIdFromEmail(email, state.users.map((u) => u.id)),
    email,
    password,
    token: session.token,
    tokenExpiresAt: session.expiresAt,
    homeClubId: session.homeClubId,
    memberId: session.memberId,
  };
  deps.io.print(`Added ${user.id}.`);
  return user;
}

async function changePassword(user: User, deps: UsersDeps): Promise<User | undefined> {
  const password = await deps.io.askHidden(`New password for ${user.id}: `);
  const session = await tryLogin(user.email, password, deps);
  if (!session) return undefined;
  deps.io.print(`Password changed for ${user.id}.`);
  return { ...user, password, token: session.token, tokenExpiresAt: session.expiresAt };
}

/** Drops the user and every reference to them from snipers (userIds and lastOutcome). */
export function removeUser(state: State, userId: string): State {
  return {
    ...state,
    users: state.users.filter((u) => u.id !== userId),
    snipers: state.snipers.map((s) => {
      const next = { ...s, userIds: s.userIds.filter((id) => id !== userId) };
      if (s.lastOutcome && userId in s.lastOutcome) {
        const { [userId]: _dropped, ...rest } = s.lastOutcome;
        next.lastOutcome = rest;
      }
      return next;
    }),
  };
}
