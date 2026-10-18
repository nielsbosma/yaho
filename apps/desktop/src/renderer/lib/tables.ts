const row = /^\s*\|.*\|\s*$/;
const rule = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

/**
 * Agents sometimes write a table without the |---| line under its header, which Markdown shows as one run-on
 * paragraph. Two or more lines that start and end with | get that line (and a blank line before them).
 */
export function fixTables(md: string): string {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let fenced = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*```/.test(line)) fenced = !fenced;
    const starts = !fenced && row.test(line) && !row.test(lines[i - 1] ?? '') && row.test(lines[i + 1] ?? '');
    if (starts && !rule.test(lines[i + 1]!)) {
      const cols = line
        .trim()
        .slice(1, -1)
        .split(/(?<!\\)\|/).length;
      if (out.length && out.at(-1)!.trim()) out.push('');
      out.push(line, `|${' --- |'.repeat(cols)}`);
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}
