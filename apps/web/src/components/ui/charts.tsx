import { cn } from '@/lib/cn';

/** Stacked daily bars (e.g. runs per day by status). Pure SVG, theme-aware. */
export function StackedBars({
  days,
  series,
  height = 140,
  className,
}: {
  days: string[];
  series: { key: string; color: string; values: number[] }[];
  height?: number;
  className?: string;
}) {
  const totals = days.map((_, i) => series.reduce((s, x) => s + (x.values[i] ?? 0), 0));
  const max = Math.max(1, ...totals);
  const bw = 100 / Math.max(1, days.length);
  return (
    <div className={cn('w-full', className)}>
      <svg
        viewBox={`0 0 100 ${height}`}
        preserveAspectRatio="none"
        className="w-full"
        style={{ height }}
        role="img"
        aria-label="Daily chart"
      >
        {[0.25, 0.5, 0.75].map((f) => (
          <line
            key={f}
            x1={0}
            x2={100}
            y1={height * f}
            y2={height * f}
            stroke="var(--color-line)"
            strokeWidth={0.4}
            vectorEffect="non-scaling-stroke"
          />
        ))}
        {days.map((d, i) => {
          let y = height;
          return (
            <g key={d}>
              <title>{`${d}: ${series.map((s) => `${s.key} ${s.values[i] ?? 0}`).join(', ')}`}</title>
              {series.map((s) => {
                const h = ((s.values[i] ?? 0) / max) * (height - 4);
                y -= h;
                return h > 0 ? (
                  <rect key={s.key} x={i * bw + bw * 0.18} width={bw * 0.64} y={y} height={h} fill={s.color} rx={0.6} />
                ) : null;
              })}
            </g>
          );
        })}
      </svg>
      <div className="mt-1.5 flex justify-between font-mono text-[10px] text-fg-subtle">
        <span>{days[0]?.slice(5)}</span>
        <span>{days[days.length - 1]?.slice(5)}</span>
      </div>
    </div>
  );
}

/** Horizontal bar list for top-N comparisons. */
export function BarList({
  items,
  format = (n) => String(n),
  color = 'var(--color-accent)',
}: {
  items: { label: string; value: number; hint?: string; tone?: string }[];
  format?: (n: number) => string;
  color?: string;
}) {
  const max = Math.max(1, ...items.map((i) => i.value));
  return (
    <ul className="space-y-2">
      {items.map((i) => (
        <li key={i.label} className="text-[12px]">
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="truncate font-mono text-[11.5px]">{i.label}</span>
            <span className="shrink-0 font-mono text-[11.5px] text-fg-muted">
              {format(i.value)}
              {i.hint && <span className="text-fg-subtle"> · {i.hint}</span>}
            </span>
          </div>
          <div className="h-1.5 overflow-hidden rounded-full bg-sunken">
            <div className="h-full rounded-full" style={{ width: `${(i.value / max) * 100}%`, background: i.tone ?? color }} />
          </div>
        </li>
      ))}
    </ul>
  );
}
