import { describe, expect, it } from 'vitest';
import { parseChoice } from '../menu.js';

const items = ['B', 'C', 'D'];
const lists = ['A'];

describe('parseChoice', () => {
  it('parses number+letter item actions case-insensitively', () => {
    expect(parseChoice('2B', 3, items, lists)).toEqual({ kind: 'item', index: 2, action: 'B' });
    expect(parseChoice('2b', 3, items, lists)).toEqual({ kind: 'item', index: 2, action: 'B' });
    expect(parseChoice('  3d \n', 3, items, lists)).toEqual({ kind: 'item', index: 3, action: 'D' });
  });

  it('parses bare list actions', () => {
    expect(parseChoice('A', 3, items, lists)).toEqual({ kind: 'list', action: 'A' });
    expect(parseChoice(' a ', 3, items, lists)).toEqual({ kind: 'list', action: 'A' });
  });

  it('zero means back', () => {
    expect(parseChoice('0', 3, items, lists)).toEqual({ kind: 'back' });
    expect(parseChoice(' 0 ', 0, [], [])).toEqual({ kind: 'back' });
  });

  it('rejects out-of-range, unknown and malformed input with a hint', () => {
    for (const input of ['5B', '0B', '2Z', 'B', '', '   ', 'hello', '2', 'A2', '2BB', '02B']) {
      const result = parseChoice(input, 3, items, lists);
      expect(result.kind, input).toBe('invalid');
      if (result.kind === 'invalid') {
        expect(result.hint.length).toBeGreaterThan(0);
        expect(result.hint).not.toMatch(/\n/);
      }
    }
  });
});
