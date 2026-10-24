import { createInterface } from 'node:readline/promises';
import { password } from '@inquirer/prompts';

/** Terminal seam for the wizard screens; tests swap in `scriptedIo`. */
export interface Io {
  ask(prompt: string): Promise<string>;
  /** Reads a secret without echoing it. */
  askHidden(prompt: string): Promise<string>;
  print(line: string): void;
}

/** Real terminal: readline for plain answers, @inquirer/prompts for hidden ones. */
export function terminalIo(input: NodeJS.ReadableStream = process.stdin, output: NodeJS.WritableStream = process.stdout): Io {
  return {
    async ask(prompt) {
      // A fresh interface per question so readline never competes with inquirer for stdin.
      const rl = createInterface({ input, output, terminal: true });
      try {
        return await rl.question(prompt);
      } finally {
        rl.close();
      }
    },
    askHidden(prompt) {
      return password({ message: prompt, mask: false });
    },
    print(line) {
      output.write(`${line}\n`);
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
