import { parse } from 'yaml';

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, '')
    .split(/(?<!\\)\|/)
    .map((c) => c.trim().replace(/\\\|/g, '|'));
const isRule = (line: string) => line.includes('|') && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(line);

/** The number of cells in a line that reads as a table row (two or more, split at |), else 0. */
function rowCells(line: string | undefined): number {
  const t = line?.trim() ?? '';
  if (!t.includes('|') || isRule(t) || /^(```|#|>|[-*+]\s|\d+\.\s)/.test(t)) return 0;
  return cells(t).length >= 2 ? cells(t).length : 0;
}
const isNumber = (c: string) => /^[-+]?[$€£]?[\d,. ]+[%kKMB]?$/.test(c);

/** Rows as aligned monospace text: numbers right-aligned, a rule under the header. */
export function grid(rows: string[][]): string {
  const width = Math.max(...rows.map((r) => r.length));
  const cols = Array.from({ length: width }, (_, j) => Math.max(...rows.map((r) => (r[j] ?? '').length)));
  const line = (r: string[]) =>
    cols
      .map((w, j) => {
        const c = r[j] ?? '';
        return isNumber(c) ? c.padStart(w) : c.padEnd(w);
      })
      .join('  ')
      .trimEnd();
  return [line(rows[0]!), cols.map((w) => '-'.repeat(w)).join('  '), ...rows.slice(1).map(line)].join('\n');
}

/** A ```chart fence's YAML as rows (x down the side, a column per series), and its title; undefined when it is not a chart. */
export function chartRows(yaml: string): { title: string; rows: string[][] } | undefined {
  try {
    const r = parse(yaml) as Record<string, unknown> | null;
    if (!r || !Array.isArray(r.x) || !r.series || typeof r.series !== 'object') return undefined;
    const series = Object.entries(r.series as Record<string, unknown>).filter(([, v]) => Array.isArray(v)) as Array<[string, unknown[]]>;
    const unit = r.unit ? String(r.unit) : '';
    const fmt = (v: unknown) => (typeof v === 'number' ? v.toLocaleString('en-US') + unit : String(v ?? ''));
    const rows = [['', ...series.map(([n]) => n)], ...r.x.map((x, i) => [String(x), ...series.map(([, v]) => fmt(v[i]))])];
    return { title: r.title ? String(r.title) : 'Chart', rows };
  } catch {
    return undefined;
  }
}

/**
 * For chat apps without tables: Markdown tables and ```chart fences become fenced monospace grids
 * (a chart under its title in bold). Other fences are left as they are.
 */
export function plainTables(md: string): string {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = /^```\s*(\S*)/.exec(line);
    if (fence) {
      const body: string[] = [];
      let j = i + 1;
      for (; j < lines.length && !/^```\s*$/.test(lines[j]!); j++) body.push(lines[j]!);
      const chart = fence[1] === 'chart' ? chartRows(body.join('\n')) : undefined;
      if (chart) out.push(`**${chart.title}**`, '```', grid(chart.rows), '```');
      else out.push(...lines.slice(i, j + 1));
      i = j;
      continue;
    }
    const ruled = line.includes('|') && i + 1 < lines.length && isRule(lines[i + 1]!);
    // A table written without its |---| line still counts: two or more lines in a row with the same number of cells.
    const n = rowCells(line);
    if (ruled || (n > 0 && rowCells(lines[i + 1]) === n)) {
      const rows = [cells(line)];
      let j = ruled ? i + 2 : i + 1;
      for (; j < lines.length && (ruled ? lines[j]!.includes('|') && lines[j]!.trim() : rowCells(lines[j]) === n); j++)
        rows.push(cells(lines[j]!));
      out.push('```', grid(rows.map((r) => r.map((c) => c.replace(/\*\*|__|`/g, '')))), '```');
      i = j - 1;
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}
