export type Choice =
  | { kind: 'item'; index: number; action: string }
  | { kind: 'list'; action: string }
  | { kind: 'back' }
  | { kind: 'invalid'; hint: string };

// Parses a menu answer: `0` (back), a bare list action (`A`) or `<n><letter>` (`2B`).
export function parseChoice(
  input: string,
  itemCount: number,
  itemActions: string[],
  listActions: string[],
): Choice {
  const text = input.trim().toUpperCase();
  const items = itemActions.map((a) => a.toUpperCase());
  const lists = listActions.map((a) => a.toUpperCase());
  const hint = (reason: string): Choice => ({ kind: 'invalid', hint: `${reason} ${usage(itemCount, items, lists)}` });

  if (text === '0') return { kind: 'back' };
  if (/^[A-Z]$/.test(text)) {
    if (lists.includes(text)) return { kind: 'list', action: text };
    if (items.includes(text)) return hint(`"${text}" needs an item number, e.g. 1${text}.`);
    return hint(`Unknown action "${text}".`);
  }
  const match = /^([1-9]\d*)([A-Z])$/.exec(text);
  if (!match) return hint(text === '' ? 'Empty choice.' : `Cannot read "${text}".`);
  const index = Number(match[1]);
  const action = match[2] as string;
  if (index > itemCount) return hint(`No item ${index}.`);
  if (!items.includes(action)) return hint(`Unknown item action "${action}".`);
  return { kind: 'item', index, action };
}

function usage(itemCount: number, items: string[], lists: string[]): string {
  const parts = [...lists];
  if (itemCount > 0 && items.length > 0) parts.push(`1-${itemCount} + ${items.join('/')}`);
  parts.push('0 = back');
  return `Use: ${parts.join(', ')}.`;
}
