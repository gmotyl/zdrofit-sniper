# zdrofit-sniper

Books Zdrofit weekly classes for several users at the second the booking window opens.

Zdrofit opens booking for a class two days before it starts, at the same wall-clock time
(a Saturday 20:00 class opens on Thursday at 20:00, Warsaw time). Popular classes fill within
seconds. A **sniper** is a weekly slot (club, weekday, start time, class name) plus the users to
book. The daemon sleeps until the next opening and then books every user of that sniper.

This is an **unofficial** tool. It talks to the ClientPortal2 member API, the same one the
Zdrofit web portal uses. It is not affiliated with or endorsed by Zdrofit.

## Risks — read first

- **Terms of service / account risk.** Automated booking may break Zdrofit's terms. Zdrofit
  may block or close an account that uses it. Use it at your own risk, for your own accounts.
- **No-shows.** Zdrofit blocks booking for 7 days after 3 no-shows within 21 days. The sniper
  books every week without asking. Cancel classes you won't attend, in the Zdrofit app or
  through the link in Zdrofit's confirmation e-mail. The sniper never cancels anything.
- **Waitlist.** Booking a full class puts the user on Zdrofit's waitlist. The outcome is then
  `Waitlisted`. Zdrofit promotes the user when a seat frees up and sends an e-mail. A promoted
  class counts as booked, so the no-show rule applies to it too.
- **DST weekends.** The opening time is computed on the Warsaw wall clock only. On the two
  weekends a year when the clocks change, a shot may fire an hour off. This is an accepted risk.
- **Plaintext credentials.** See [Data directory](#data-directory).

## Setup

Requires Node.js 22 or later and pnpm.

```sh
pnpm install && pnpm build
pnpm sniper setup     # interactive wizard: users and snipers
pnpm sniper daemon    # sleep until the next opening, then book
```

## Wizard (`pnpm sniper setup`)

The prompts are in Polish; this section lists the keys.

Main menu:

| Key | Action          |
| --- | --------------- |
| `1` | manage users    |
| `2` | manage snipers  |
| `0` | exit            |

Each screen shows a numbered list and an action line. Type a letter, or a list number followed
by a letter (`2B` acts on item 2):

| Key  | Users screen          | Snipers screen              |
| ---- | --------------------- | --------------------------- |
| `A`  | add a user            | add a sniper                |
| `nB` | remove user n         | remove sniper n             |
| `nC` | change n's password   | toggle sniper n's users     |
| `nD` | —                     | activate / deactivate n     |
| `0`  | back                  | back                        |

Adding a user logs in to Zdrofit once to check the e-mail and password and to read the home club.

Adding a sniper walks through:

1. **Club.** Enter takes the suggested club (the last one used, otherwise the first user's home
   club). Any other text filters clubs by name or city, ignoring case and Polish diacritics
   (`lodz` matches `Łódź`). Pick by number, or type a new filter.
2. **Weekday.** `1` = Monday … `7` = Sunday.
3. **Slot.** The wizard lists that weekday's classes at the club. If the next date is not
   published yet, it uses the same weekday a week earlier. Filter by name (Enter shows all).
   At `Wybierz slot [lub zmień filtr]` type a number to pick, or new text to filter again.
4. **Users.** Comma-separated numbers, e.g. `2,1`. Users are booked in that order.

New snipers are active. Every change is saved at once and restarts the daemon (see below).

## Daemon (`pnpm sniper daemon`)

- Writes its PID to `data/daemon.pid`. A second daemon exits if one is already running —
  checked by PID plus `/proc/<pid>/cmdline` (`…/cli.js daemon`), so a PID reused by an
  unrelated process after a crash does not block it.
- Reads the state once, logs the next opening, and sleeps until 10 minutes before it.
- Each shot follows a fixed timeline relative to the opening (T):
  - **T−10 min:** logs in again for users whose token is missing or expires within a day. A
    failed login marks that user `Failed` (`login`).
  - **T−5 min:** fetches the club's classes for the date and resolves the sniper's slot to a
    class id (one retry; otherwise every user fails with `classes unavailable` or
    `slot not found`).
  - **T−2 s:** books all users concurrently. "Too early" refusals and network errors are
    retried every 300 ms, for up to 60 s after the first attempt; any other refusal fails at
    once.
  - **Confirmation:** for each accepted user, it re-reads the class list with that user's own
    token. Listed as a participant → `Booked`; class full or waitlist-only → `Waitlisted`;
    otherwise `Failed`.
- Each user's outcome (`Booked`, `Waitlisted`, or `Failed` with a reason) is saved as the
  sniper's last outcome, which the wizard shows.
- **Reload = restart.** After every save the wizard sends `SIGTERM` to the daemon, even during a
  shot. A supervisor loop (see [Deploy](#deploy)) starts it again with the new state. If no
  daemon is running, the wizard prints a hint to start one.
- With no active sniper, the daemon idles until the wizard restarts it.

## Data directory

Everything lives in `$ZDROFIT_SNIPER_DATA`. The default is `./data`, relative to the working
directory.

| Path               | Contents                                   |
| ------------------ | ------------------------------------------ |
| `state.json`       | users, snipers, tokens, last outcomes      |
| `daemon.pid`       | PID of the running daemon                  |
| `logs/YYYY-MM.log` | shot outcome lines, one file per UTC month |

> **Warning: `data/` holds plaintext credentials.** `state.json` stores each user's Zdrofit
> e-mail, password, and session tokens unencrypted. The tool creates the directory with mode
> `700` and files with mode `600`. Keep it that way (`chmod 600 data/state.json`). `data/` is in
> `.gitignore`: never commit it, copy it into backups you share, or paste it anywhere.

Daemon messages (next opening, idling, errors) go to stdout, which the sidecar below appends to
`data/logs/daemon.out`. Both logs identify users only by their user id, a slug of the e-mail's
local part (e.g. `jan-kowalski`); they never contain passwords, tokens, or full e-mail addresses.

## Deploy

On a server, run the daemon under a restart loop so that it comes back after each wizard save
(and after a crash). For example, add a sidecar to the host's `start.sh` (here, the
ai-server-agent's), before its main loop:

```sh
if [[ -f /git/zdrofit-sniper/dist/cli.js ]]; then
  ( cd /git/zdrofit-sniper && mkdir -p data/logs && chmod 700 data \
    && while true; do node dist/cli.js daemon >> data/logs/daemon.out 2>&1 || true; sleep 5; done ) &
fi
```

The `|| true` matters: the subshell inherits the host script's `set -e`, so without it a crash
or an `exit 1` (for example "daemon already running" or a corrupt `state.json`) would end the
loop for good. `mkdir -p data/logs` runs first because the shell opens the redirect before the
daemon gets a chance to create the directory. Then run `pnpm sniper setup` in the same
directory to manage users and snipers. Daemon output goes to `data/logs/daemon.out`; shot
outcomes go to `data/logs/YYYY-MM.log`.

## Development

```sh
pnpm test     # vitest (watch mode; `pnpm test --run` for a single run)
pnpm lint     # type-check, tests included
pnpm dev      # run the CLI from source via tsx, e.g. `pnpm dev setup`
```

No test talks to Zdrofit or books a real class.

## License

MIT — see [LICENSE](./LICENSE).
