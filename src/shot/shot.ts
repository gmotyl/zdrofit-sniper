// One booking shot for one sniper occurrence. Never logs tokens, passwords or e-mails.
import type { BookResult, ClassItem } from "../api/client.js";
import { matchSlot } from "../schedule/match.js";
import type { Occurrence } from "../schedule/opening.js";
import { saveState, type Outcome, type State, type User } from "../store/state.js";

export interface ShotDeps { api: typeof import("../api/client.js"); now(): Date; sleep(ms: number): Promise<void>; log(line: string): void }

const MIN = 60_000;
const DAY = 86_400_000;
const REFRESH_AT = 10 * MIN; // before opening
const RESOLVE_AT = 5 * MIN;
const FIRE_AT = 2_000;
const RETRY_EVERY = 300;
const RETRY_BUDGET = 60_000; // after the first attempt
const WAITLIST_STATUSES = new Set(["FullBooked", "Awaitable"]);

/** Per-user progress; `status` and `correlationId` go to the log line. */
interface Shooter { user?: User; outcome?: Outcome; status?: number; correlationId?: string }

/** `UserId` claim of a ClientPortal2 JWT; fallback for users saved before memberId was stored. */
function jwtUserId(token: string): number | undefined {
  try {
    const p = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
    return typeof p.UserId === "number" ? p.UserId : undefined;
  } catch {
    return undefined;
  }
}

export async function runShot(state: State, sniperId: string, occ: Occurrence, deps: ShotDeps): Promise<Record<string, Outcome>> {
  const sniper = state.snipers.find((s) => s.id === sniperId);
  if (!sniper) throw new Error(`unknown sniper ${sniperId}`);
  const { api } = deps;
  const T = occ.opening.getTime();
  const sleepUntil = async (at: number) => {
    const ms = at - deps.now().getTime();
    if (ms > 0) await deps.sleep(ms);
  };
  const fail = (reason: string): Outcome => ({ date: occ.date, result: "Failed", reason });
  const shooters = new Map<string, Shooter>(
    sniper.userIds.map((id): [string, Shooter] => {
      const user = state.users.find((u) => u.id === id);
      return [id, user ? { user } : { outcome: fail("unknown user") }];
    }),
  );
  const live = () => [...shooters.values()].filter((s): s is Shooter & { user: User } => !s.outcome && !!s.user);

  // T−10 min: refresh tokens missing or expiring within a day.
  await sleepUntil(T - REFRESH_AT);
  const horizon = deps.now().getTime() + DAY;
  let refreshed = false;
  await Promise.all(
    live()
      .filter(({ user }) => !user.token || !user.tokenExpiresAt || Date.parse(user.tokenExpiresAt) < horizon)
      .map(async (s) => {
        try {
          const session = await api.login(s.user.email, s.user.password);
          s.user.token = session.token;
          s.user.tokenExpiresAt = session.expiresAt;
          s.user.memberId = session.memberId;
          refreshed = true;
        } catch {
          s.outcome = fail("login");
        }
      }),
  );
  if (refreshed) saveState(state);

  // Outside the fire loop: one retry, then give up.
  const classesOnce = async (token?: string): Promise<ClassItem[] | undefined> => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await api.dailyClasses(sniper.clubId, occ.date, token);
      } catch {
        // retried once
      }
    }
    return undefined;
  };

  // T−5 min: resolve the class id.
  await sleepUntil(T - RESOLVE_AT);
  let classId: number | undefined;
  if (live().length > 0) {
    const classes = await classesOnce();
    const cls = classes && matchSlot(sniper, classes);
    if (!classes) for (const s of live()) s.outcome = fail("classes unavailable");
    else if (!cls) for (const s of live()) s.outcome = fail("slot not found");
    else classId = cls.id;
  }

  if (classId !== undefined) {
    const id = classId;
    // T−2 s: fire all users concurrently; book even when the class looks full.
    await sleepUntil(T - FIRE_AT);
    await Promise.all(
      live().map(async (s) => {
        const token = s.user.token!;
        const first = deps.now().getTime();
        for (;;) {
          let r: BookResult | undefined;
          try {
            r = await api.bookClass(token, id, sniper.clubId);
          } catch {
            r = undefined; // network error: retried like an early refusal
          }
          if (r && !r.ok) {
            s.status = r.status;
            if (r.correlationId) s.correlationId = r.correlationId;
          }
          // 200 without Tickets counts as accepted (possibly a waitlist place); confirmation decides.
          if (r && (r.ok || r.status === 200)) {
            s.status = 200;
            return;
          }
          if (r && !r.early) {
            s.outcome = fail(`http ${r.status}`);
            return;
          }
          if (deps.now().getTime() + RETRY_EVERY - first > RETRY_BUDGET) {
            s.outcome = fail("retry budget");
            return;
          }
          await deps.sleep(RETRY_EVERY);
        }
      }),
    );

    // Confirm with each accepted user's own token.
    await Promise.all(
      live().map(async (s) => {
        const classes = await classesOnce(s.user.token);
        const cls = classes?.find((c) => c.id === id);
        if (!cls) {
          s.outcome = fail("unconfirmed");
          return;
        }
        const memberId = s.user.memberId ?? jwtUserId(s.user.token!);
        if (memberId !== undefined && cls.userIds.includes(memberId)) s.outcome = { date: occ.date, result: "Booked" };
        // Waitlist response shape is unverified (Task 2 spike not run); design fallback: accepted, full, not listed.
        else if (WAITLIST_STATUSES.has(cls.status)) s.outcome = { date: occ.date, result: "Waitlisted" };
        else s.outcome = fail("not in class");
      }),
    );
  }

  const outcomes: Record<string, Outcome> = {};
  for (const [userId, s] of shooters) outcomes[userId] = s.outcome ?? fail("unknown");
  // Persist before logging: a failing log must never lose the outcome.
  sniper.lastOutcome = outcomes;
  saveState(state);
  for (const [userId, s] of shooters) {
    const o = outcomes[userId]!;
    try {
      deps.log(
        `sniper=${sniper.id} user=${userId} date=${o.date} result=${o.result}` +
          (o.reason ? ` reason="${o.reason}"` : "") +
          ` status=${s.status ?? "-"} corr=${s.correlationId ?? "-"}`,
      );
    } catch {
      // Logging is best effort; the outcome is already saved.
    }
  }
  return outcomes;
}
