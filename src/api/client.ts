// Thin ClientPortal2 client. Never puts a password or token into an error message or log.

export const BASE = "https://zdrofit.perfectgym.pl/ClientPortal2/";

export interface Club {
  id: number;
  name: string;
  city: string;
}

export interface ClassItem {
  id: number;
  timeTableId?: number;
  name: string;
  trainer?: string;
  start: string; // club-local ISO, no offset
  status: "Bookable" | "FullBooked" | "Awaitable" | "Unavailable" | string;
  userIds: number[];
  limit?: number; // BookingIndicator.Limit
  available?: number; // BookingIndicator.Available
}

/** `body` is a short, whitespace-collapsed excerpt of a refusal, kept for diagnostics. */
export type BookResult = { ok: true } | { ok: false; status: number; early: boolean; correlationId?: string; body?: string };

export interface Session {
  token: string;
  expiresAt: string;
  homeClubId: number;
  memberId: number;
}

export class LoginRefused extends Error {
  constructor(public readonly status: number) {
    super(`login refused (HTTP ${status})`);
    this.name = "LoginRefused";
  }
}

const HEADERS: Record<string, string> = {
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "pl",
  "CP-LANG": "pl",
  "CP-MODE": "desktop",
  "Content-Type": "application/json",
  Origin: "https://zdrofit.perfectgym.pl",
  Referer: BASE,
};

async function call(method: "GET" | "POST", path: string, body?: unknown, token?: string) {
  const headers = token ? { ...HEADERS, Authorization: `Bearer ${token}` } : { ...HEADERS };
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text().catch(() => "");
  let json: any = undefined;
  try {
    json = JSON.parse(text);
  } catch {
    // Non-JSON bodies (e.g. the 499 plain text) are expected; callers use `text`.
  }
  return { res, json, text };
}

function jwtExp(token: string): string | undefined {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString("utf8"));
    return typeof payload.exp === "number" ? new Date(payload.exp * 1000).toISOString() : undefined;
  } catch {
    return undefined;
  }
}

export async function login(email: string, password: string): Promise<Session> {
  const { res, json } = await call("POST", "Auth/Login", { RememberMe: true, Login: email, Password: password });
  const token = res.headers.get("jwt-token");
  const member = json?.User?.Member;
  if (res.status !== 200 || !token) throw new LoginRefused(res.status);
  const expiresAt = jwtExp(token);
  if (!expiresAt || typeof member?.HomeClubId !== "number" || typeof member?.Id !== "number") {
    throw new LoginRefused(res.status);
  }
  return { token, expiresAt, homeClubId: member.HomeClubId, memberId: member.Id };
}

export async function clubs(token?: string): Promise<Club[]> {
  const { res, json } = await call("GET", "Clubs/GetAvailableClassesClubs", undefined, token);
  if (res.status !== 200) throw new Error(`clubs failed (HTTP ${res.status})`);
  const list: any[] = Array.isArray(json) ? json : Array.isArray(json?.Clubs) ? json.Clubs : [];
  return list.map((c) => ({ id: c.Id, name: String(c.Name ?? ""), city: String(c.City ?? "") }));
}

// Users entries were empty in every spike; accept a bare id or an object with UserId / MemberId / Id.
function userId(u: unknown): number | undefined {
  if (typeof u === "number") return u;
  if (u && typeof u === "object") {
    const o = u as Record<string, unknown>;
    const v = o.UserId ?? o.MemberId ?? o.Id;
    return typeof v === "number" ? v : undefined;
  }
  return undefined;
}

export async function dailyClasses(clubId: number, date: string, token?: string): Promise<ClassItem[]> {
  const { res, json } = await call("POST", "Classes/ClassCalendar/DailyClasses", { clubId, date }, token);
  if (res.status !== 200) throw new Error(`dailyClasses failed (HTTP ${res.status})`);
  const hours: any[] = Array.isArray(json?.CalendarData) ? json.CalendarData : [];
  return hours.flatMap((h) => (Array.isArray(h?.Classes) ? h.Classes : [])).map((c: any): ClassItem => {
    const item: ClassItem = {
      id: c.Id,
      name: String(c.Name ?? ""),
      start: String(c.StartTime ?? ""),
      status: String(c.Status ?? ""),
      userIds: (Array.isArray(c.Users) ? c.Users : []).map(userId).filter((x: unknown): x is number => typeof x === "number"),
    };
    const tt = c.ClassRatingSummaryInfo?.TimeTableId;
    if (typeof tt === "number") item.timeTableId = tt;
    if (typeof c.Trainer === "string") item.trainer = c.Trainer;
    const bi = c.BookingIndicator;
    if (typeof bi?.Limit === "number") item.limit = bi.Limit;
    if (typeof bi?.Available === "number") item.available = bi.Available;
    return item;
  });
}

const CORRELATION_IN_BODY = /CorrelationId:\s*"?([^"\s]+)"?/;
const BODY_EXCERPT = 120;

export async function bookClass(token: string, classId: number, clubId: number): Promise<BookResult> {
  // The web client sends clubId as a string here (spike 3).
  const { res, json, text } = await call("POST", "Classes/ClassCalendar/BookClass", { classId, clubId: String(clubId) }, token);
  if (res.status === 200 && Array.isArray(json?.Tickets) && json.Tickets.length > 0) return { ok: true };
  const out: BookResult = { ok: false, status: res.status, early: res.status === 499 };
  const correlationId = res.headers.get("pg-correlation-id") ?? CORRELATION_IN_BODY.exec(text)?.[1];
  if (correlationId) out.correlationId = correlationId;
  const body = text.replace(/\s+/g, " ").trim().slice(0, BODY_EXCERPT);
  if (body) out.body = body;
  return out;
}
