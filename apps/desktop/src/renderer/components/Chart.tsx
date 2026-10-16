import { useEffect, useRef, useState } from 'react';
import { parse } from 'yaml';

export const SERIES_MAX = 6;

export interface ChartSpec {
  type: 'bar' | 'line';
  title: string;
  x: string[];
  series: Array<{ name: string; values: number[] }>;
  unit: string;
}

/** A ```chart fence's YAML as a chart, or the reason it is not one. */
export function parseChart(text: string): ChartSpec | string {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (err) {
    return err instanceof Error ? err.message : String(err);
  }
  if (!raw || typeof raw !== 'object') return 'A chart needs x and series.';
  const r = raw as Record<string, unknown>;
  const type = r.type === undefined ? 'bar' : r.type;
  if (type !== 'bar' && type !== 'line') return 'type is bar or line.';
  if (!Array.isArray(r.x) || !r.x.length) return 'x is a list of labels.';
  if (!r.series || typeof r.series !== 'object' || Array.isArray(r.series)) return 'series maps names to lists of numbers.';
  const x = r.x.map(String);
  const series = Object.entries(r.series as Record<string, unknown>).map(([name, v]) => ({
    name,
    values: Array.isArray(v) ? v.map(Number) : [],
  }));
  if (!series.length) return 'series is empty.';
  if (series.length > SERIES_MAX) return `At most ${SERIES_MAX} series.`;
  for (const s of series)
    if (s.values.length !== x.length || s.values.some((n) => !Number.isFinite(n)))
      return `${s.name} needs ${x.length} numbers, one for each x.`;
  return { type, title: r.title ? String(r.title) : '', x, series, unit: r.unit ? String(r.unit) : '' };
}

/** Round tick values covering lo..hi. */
export function ticks(lo: number, hi: number, count = 4): number[] {
  if (lo === hi) hi = lo + 1;
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = ([1, 2, 2.5, 5, 10].find((m) => m * mag >= raw) ?? 10) * mag;
  const out: number[] = [];
  for (let t = Math.floor(lo / step) * step; t < hi + step * 0.999; t += step) out.push(Number(t.toPrecision(12)));
  return out;
}

const compact = (n: number) => {
  const a = Math.abs(n);
  if (a >= 1e9) return `${+(n / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${+(n / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${+(n / 1e3).toFixed(1)}K`;
  return String(+n.toFixed(2));
};
const full = (n: number, unit: string) => `${n.toLocaleString('en-US')}${unit}`;
const color = (i: number) => `var(--c-series-${i + 1})`;

const H = 220;
const M = { top: 10, right: 12, bottom: 26, left: 44 };

/** A bar or line chart from a ```chart fence, with a legend, a hover readout and a table view. */
export function Chart({ spec }: { spec: ChartSpec }) {
  const box = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(560);
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => e && setW(Math.max(240, Math.floor(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const all = spec.series.flatMap((s) => s.values);
  const ys = ticks(Math.min(0, ...all), Math.max(0, ...all));
  const lo = ys[0]!;
  const hi = ys.at(-1)!;
  const pw = w - M.left - M.right;
  const ph = H - M.top - M.bottom;
  const band = pw / spec.x.length;
  const y = (v: number) => M.top + ph - ((v - lo) / (hi - lo)) * ph;
  const cx = (i: number) => M.left + band * (i + 0.5);
  const k = spec.series.length;
  const bw = Math.max(2, Math.min(24, (band * 0.7 - 2 * (k - 1)) / k));
  const labelEvery = Math.max(1, Math.ceil(spec.x.length / Math.max(1, Math.floor(pw / 64))));

  const bar = (v: number, i: number, j: number) => {
    const x0 = cx(i) - (k * bw + 2 * (k - 1)) / 2 + j * (bw + 2);
    const base = y(0);
    const end = y(v);
    const h = Math.abs(base - end);
    const r = Math.min(4, h, bw / 2);
    const dir = v >= 0 ? 1 : -1;
    const top = base - dir * h;
    const d = `M${x0},${base} V${top + dir * r} Q${x0},${top} ${x0 + r},${top} H${x0 + bw - r} Q${x0 + bw},${top} ${x0 + bw},${top + dir * r} V${base} Z`;
    return <path key={`${i}-${j}`} d={d} fill={color(j)} opacity={hover === null || hover === i ? 1 : 0.55} />;
  };

  return (
    <div ref={box} className="my-3 rounded-lg border border-line bg-panel p-3">
      <div className="mb-2 flex items-start gap-3">
        <div className="min-w-0 flex-1">
          {spec.title && <div className="text-sm font-medium text-ink">{spec.title}</div>}
          {k > 1 && (
            <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
              {spec.series.map((s, j) => (
                <span key={s.name} className="flex items-center gap-1.5">
                  <span className="inline-block size-2.5 rounded-sm" style={{ background: color(j) }} />
                  {s.name}
                </span>
              ))}
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={() => setTable(!table)}
          className="shrink-0 cursor-pointer rounded-md border border-line px-2 py-0.5 text-xs font-medium text-muted hover:bg-hover"
        >
          {table ? 'Chart' : 'Table'}
        </button>
      </div>
      {table ? (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr>
                <th className="border-b border-line px-2 py-1 text-left font-medium text-muted" />
                {spec.series.map((s) => (
                  <th key={s.name} className="border-b border-line px-2 py-1 text-right font-medium text-muted">
                    {s.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {spec.x.map((l, i) => (
                <tr key={i}>
                  <td className="border-b border-line px-2 py-1">{l}</td>
                  {spec.series.map((s) => (
                    <td key={s.name} className="border-b border-line px-2 py-1 text-right tabular-nums">
                      {full(s.values[i]!, spec.unit)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="relative" onMouseLeave={() => setHover(null)}>
          <svg width={w} height={H} className="block text-[11px]" role="img" aria-label={spec.title || 'Chart'}>
            {ys.map((t) => (
              <g key={t}>
                <line x1={M.left} x2={w - M.right} y1={y(t)} y2={y(t)} stroke="var(--c-line)" />
                <text x={M.left - 6} y={y(t)} dy="0.32em" textAnchor="end" fill="var(--c-muted)">
                  {compact(t)}
                </text>
              </g>
            ))}
            {hover !== null && <rect x={M.left + band * hover} y={M.top} width={band} height={ph} fill="var(--c-hover)" />}
            {spec.x.map(
              (l, i) =>
                i % labelEvery === 0 && (
                  <text key={i} x={cx(i)} y={H - 8} textAnchor="middle" fill="var(--c-muted)">
                    {l.length > 14 ? l.slice(0, 13) + '…' : l}
                  </text>
                ),
            )}
            {spec.type === 'bar'
              ? spec.series.map((s, j) => s.values.map((v, i) => bar(v, i, j)))
              : spec.series.map((s, j) => (
                  <g key={s.name}>
                    <polyline
                      points={s.values.map((v, i) => `${cx(i)},${y(v)}`).join(' ')}
                      fill="none"
                      stroke={color(j)}
                      strokeWidth={2}
                      strokeLinejoin="round"
                      strokeLinecap="round"
                    />
                    {s.values.map(
                      (v, i) =>
                        (hover === i || s.values.length <= 12) && (
                          <circle key={i} cx={cx(i)} cy={y(v)} r={4} fill={color(j)} stroke="var(--c-panel)" strokeWidth={2} />
                        ),
                    )}
                  </g>
                ))}
            {spec.x.map((_, i) => (
              <rect key={i} x={M.left + band * i} y={M.top} width={band} height={ph} fill="transparent" onMouseEnter={() => setHover(i)} />
            ))}
          </svg>
          {hover !== null && (
            <div
              className="pointer-events-none absolute top-1 z-10 min-w-32 rounded-md border border-line bg-panel px-2.5 py-1.5 text-xs shadow-md"
              style={cx(hover) > w / 2 ? { right: w - cx(hover) + band / 2 } : { left: cx(hover) + band / 2 }}
            >
              <div className="mb-1 font-medium text-ink">{spec.x[hover]}</div>
              {spec.series.map((s, j) => (
                <div key={s.name} className="flex items-center gap-1.5 text-muted">
                  <span className="inline-block size-2 rounded-sm" style={{ background: color(j) }} />
                  <span className="flex-1">{s.name}</span>
                  <span className="ml-3 text-ink tabular-nums">{full(s.values[hover]!, spec.unit)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
