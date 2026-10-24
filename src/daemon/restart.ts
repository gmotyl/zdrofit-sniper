// Reload = restart: after every wizard save the running daemon is told to exit; start.sh brings it back.
import { saveState, type State } from "../store/state.js";
import { isDaemonAlive, readPid } from "./daemon.js";

export const NOT_RUNNING_HINT = "daemon not running — start it with pnpm sniper daemon";

export interface RestartDeps {
  isAlive(pid: number): boolean;
  kill(pid: number, signal: "SIGTERM"): void;
  print(line: string): void;
}

const realDeps: RestartDeps = {
  isAlive: (pid) => isDaemonAlive(pid),
  kill: (pid, signal) => {
    process.kill(pid, signal);
  },
  print: (line) => console.log(line),
};

/** SIGTERMs the daemon named in daemon.pid, immediately (even mid-shot); prints a hint when none runs. */
export function restartDaemon(deps: RestartDeps = realDeps): void {
  const pid = readPid();
  if (pid !== undefined && pid !== process.pid && deps.isAlive(pid)) {
    try {
      deps.kill(pid, "SIGTERM");
      return;
    } catch (err) {
      // Exited between the check and the signal: same as not running.
      if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
    }
  }
  deps.print(NOT_RUNNING_HINT);
}

/** The wizard's `save`: persist first, then restart so the daemon reads the new state. */
export function saveAndRestart(state: State, deps: RestartDeps = realDeps): void {
  saveState(state);
  restartDaemon(deps);
}
