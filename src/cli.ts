#!/usr/bin/env node
// Entry point: dispatches the `setup` and `daemon` subcommands.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import * as api from "./api/client.js";
import { startDaemon } from "./daemon/daemon.js";
import { saveAndRestart } from "./daemon/restart.js";
import { loadState, type State } from "./store/state.js";
import { terminalIo, type Io } from "./wizard/io.js";
import { snipersScreen } from "./wizard/snipers.js";
import { usersScreen } from "./wizard/users.js";

const HELP = `Usage: sniper <command>

Commands:
  setup    Interactive wizard: manage users and snipers
  daemon   Sleep until the next booking opening and book

Options:
  -h, --help  Show this help
`;

export const MAIN_MENU = ["Zdrofit sniper", "  1 - manage users", "  2 - manage snipers", "  0 - exit"];

export interface CliDeps {
  loadState(): State;
  /** The wizard's terminal; `close` releases stdin so the process can exit. */
  io(): Io & { close?(): void };
  usersScreen(state: State, io: Io): Promise<State>;
  snipersScreen(state: State, io: Io): Promise<State>;
  startDaemon(): Promise<never>;
}

const realDeps: CliDeps = {
  loadState,
  io: () => terminalIo(),
  usersScreen: (state, io) =>
    usersScreen(state, { io, api: { login: api.login, clubs: () => api.clubs() }, save: saveAndRestart }),
  snipersScreen: (state, io) =>
    snipersScreen(state, {
      io,
      api: { clubs: () => api.clubs(), dailyClasses: (clubId, date) => api.dailyClasses(clubId, date) },
      save: saveAndRestart,
    }),
  startDaemon,
};

/** Main menu takes a bare number, unlike the screens' `<n><letter>` grammar of `parseChoice`. */
export function parseMainChoice(input: string): "users" | "snipers" | "exit" | undefined {
  switch (input.trim()) {
    case "1":
      return "users";
    case "2":
      return "snipers";
    case "0":
      return "exit";
    default:
      return undefined;
  }
}

async function setup(deps: CliDeps): Promise<number> {
  // Load before opening the terminal: a corrupt state file fails fast and is never overwritten.
  let state = deps.loadState();
  const io = deps.io();
  try {
    for (;;) {
      io.print("");
      for (const line of MAIN_MENU) io.print(line);
      let answer: string;
      try {
        answer = await io.ask("> ");
      } catch (err) {
        if ((err as Error).message === "input closed") return 0; // EOF / Ctrl+C
        throw err;
      }
      const choice = parseMainChoice(answer);
      if (choice === "exit") return 0;
      if (choice === "users") state = await deps.usersScreen(state, io);
      else if (choice === "snipers") state = await deps.snipersScreen(state, io);
      else io.print("Use: 1, 2, 0 = exit.");
    }
  } finally {
    io.close?.();
  }
}

export async function main(argv: string[], deps: CliDeps = realDeps): Promise<number> {
  const [command] = argv;

  try {
    switch (command) {
      case "setup":
        return await setup(deps);
      case "daemon":
        return await deps.startDaemon();
      case undefined:
      case "-h":
      case "--help":
      case "help":
        process.stdout.write(HELP);
        return 0;
      default:
        process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
        return 1;
    }
  } catch (err) {
    // One line, no stack: e.g. `Corrupt state file /path/state.json: <parse error>`.
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`sniper ${command}: ${message.replace(/\s*\n\s*/g, " ")}\n`);
    return 1;
  }
}

/** True when this module is the process entry (also via the pnpm bin symlink), not an import. */
function isEntry(): boolean {
  const script = process.argv[1];
  if (!script) return false;
  try {
    return realpathSync(script) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntry()) process.exitCode = await main(process.argv.slice(2));
