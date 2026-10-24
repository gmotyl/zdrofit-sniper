import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { terminalIo } from '../io.js';

function streams(tty: boolean) {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = '';
  output.on('data', (c: Buffer) => (written += c.toString()));
  if (tty) Object.assign(input, { isTTY: true, setRawMode: () => input });
  return { input, output, written: () => written };
}

const tick = () => new Promise<void>((r) => setImmediate(r));

describe('terminalIo', () => {
  it('buffers lines that arrive before they are asked for', async () => {
    const { input, output } = streams(false);
    const io = terminalIo(input, output);
    input.write('a\nb\nc\n');
    await tick();
    expect(await io.ask('1> ')).toBe('a');
    expect(await io.ask('2> ')).toBe('b');
    expect(await io.ask('3> ')).toBe('c');
    io.close();
  });

  it('hands a queued line to a hidden ask in order', async () => {
    const { input, output } = streams(false);
    const io = terminalIo(input, output);
    input.write('ewa@example.com\ns3cret\n1\n');
    await tick();
    expect(await io.ask('E-mail > ')).toBe('ewa@example.com');
    expect(await io.askHidden('Password > ')).toBe('s3cret');
    expect(await io.ask('> ')).toBe('1');
    io.close();
  });

  it('does not echo a hidden answer on a TTY', async () => {
    const { input, output, written } = streams(true);
    const io = terminalIo(input, output);
    const visible = io.ask('Name > ');
    input.write('visible-text\r');
    expect(await visible).toBe('visible-text');
    const hidden = io.askHidden('Password > ');
    input.write('s3cret\r');
    expect(await hidden).toBe('s3cret');
    await tick();
    // Control: the plain answer was echoed, so the stream does carry readline's echo.
    expect(written()).toContain('visible-text');
    expect(written()).toContain('Password > ');
    expect(written()).not.toContain('s3cret');
    io.close();
  });

  it('rejects a pending ask on close', async () => {
    const { input, output } = streams(false);
    const io = terminalIo(input, output);
    const pending = io.ask('> ');
    io.close();
    await expect(pending).rejects.toThrow('input closed');
  });
});
