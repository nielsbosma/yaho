const rule = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/** The number of cells in a line that reads as a table row (two or more, split at |), else 0. */
export function rowCells(line: string | undefined): number {
  const t = line?.trim() ?? '';
  if (!t.includes('|') || rule.test(t) || /^(```|#|>|[-*+]\s|\d+\.\s)/.test(t)) return 0;
  const n = t.replace(/^\||\|$/g, '').split(/(?<!\\)\|/).length;
  return n >= 2 ? n : 0;
}

/**
 * Agents sometimes write a table without the |---| line under its header (and sometimes without the outer pipes),
 * which Markdown shows as one run-on paragraph. Two or more lines in a row with the same number of cells become a
 * table: they get that line, and a blank line before them.
 */
export function fixTables(md: string): string {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let fenced = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*```/.test(line)) fenced = !fenced;
    const n = fenced ? 0 : rowCells(line);
    const prev = lines[i - 1] ?? '';
    const starts = n > 0 && rowCells(prev) === 0 && !rule.test(prev) && rowCells(lines[i + 1]) === n;
    if (starts) {
      if (out.length && out.at(-1)!.trim()) out.push('');
      out.push(line, `|${' --- |'.repeat(n)}`);
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}
