import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';

/** Terminal seam for the wizard screens; tests swap in `scriptedIo`. */
export interface Io {
  ask(prompt: string): Promise<string>;
  /** Reads a secret without echoing it. */
  askHidden(prompt: string): Promise<string>;
  print(line: string): void;
}

export interface TerminalIo extends Io {
  /** Releases stdin so the process can exit; pending and later asks reject. */
  close(): void;
}

/** Forwards to the real output unless muted; readline echoes through it. */
class MutableOutput extends Writable {
  muted = false;
  constructor(private readonly target: NodeJS.WritableStream) {
    super();
  }
  get columns(): number | undefined {
    return (this.target as NodeJS.WriteStream).columns;
  }
  override _write(chunk: Buffer | string, _enc: BufferEncoding, done: (err?: Error | null) => void): void {
    if (!this.muted) this.target.write(chunk);
    done();
  }
}

/**
 * Real terminal: one long-lived readline for the whole session. Lines that arrive before
 * they are asked for (paste, typeahead, piped input) queue up for the next ask, in order.
 * Hidden asks mute readline's echo on the same interface, so no second reader races for stdin.
 */
export function terminalIo(input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): TerminalIo {
  const echo = new MutableOutput(output);
  const terminal = (input as NodeJS.ReadStream).isTTY === true;
  // historySize 0: a password must not be recallable with the up arrow.
  const rl = createInterface({ input, output: echo, terminal, historySize: 0 });
  const lines: string[] = [];
  const waiters: { resolve(line: string): void; reject(err: Error): void }[] = [];
  let closed = false;

  rl.on('line', (line) => {
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(line);
    else lines.push(line);
  });
  // Ctrl+C in raw mode arrives here, not as a process signal.
  rl.on('SIGINT', () => rl.close());
  rl.on('close', () => {
    closed = true;
    for (const w of waiters.splice(0)) w.reject(new Error('input closed'));
  });

  const nextLine = (): Promise<string> => {
    const queued = lines.shift();
    if (queued !== undefined) return Promise.resolve(queued);
    if (closed) return Promise.reject(new Error('input closed'));
    return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
  };

  return {
    ask(prompt) {
      rl.setPrompt(prompt);
      if (!closed) rl.prompt(true);
      return nextLine();
    },
    async askHidden(prompt) {
      rl.setPrompt('');
      output.write(prompt);
      echo.muted = true;
      try {
        return await nextLine();
      } finally {
        echo.muted = false;
        // The muted Enter left the cursor on the prompt line.
        if (terminal) output.write('\n');
      }
    },
    print(line) {
      output.write(`${line}\n`);
    },
    close() {
      rl.close();
    },
  };
}

export type IoMethod = 'ask' | 'askHidden';

export interface ScriptedIo extends Io {
  /** Every printed line, in order. */
  printed: string[];
  /** Each consumed answer with the method and prompt that consumed it. */
  consumed: { method: IoMethod; prompt: string; answer: string }[];
}

/** Test double: answers come from a script; running out throws instead of hanging. */
export function scriptedIo(answers: string[]): ScriptedIo {
  const queue = [...answers];
  const printed: string[] = [];
  const consumed: ScriptedIo['consumed'] = [];
  const next = (method: IoMethod, prompt: string): Promise<string> => {
    const answer = queue.shift();
    if (answer === undefined) {
      return Promise.reject(new Error(`scriptedIo: no answer left for ${method}(${JSON.stringify(prompt)})`));
    }
    consumed.push({ method, prompt, answer });
    return Promise.resolve(answer);
  };
  return {
    printed,
    consumed,
    ask: (prompt) => next('ask', prompt),
    askHidden: (prompt) => next('askHidden', prompt),
    print: (line) => {
      printed.push(line);
    },
  };
}
