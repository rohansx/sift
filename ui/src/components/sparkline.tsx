import { formatPercent } from "../../../src/report/model.ts";
import { cn } from "@/lib/utils";

/**
 * The terminal's ▁▂▃▄▅▆▇█ column, as an SVG polyline.
 *
 * It reproduces `sparkline()`'s two special cases rather than plotting the
 * numbers naively, because both exist to avoid lying: a series that never moved
 * sits mid-height instead of being stretched to the top (scaling a flat line to
 * the maximum invents a spike out of "nothing happened"), and an all-zero series
 * sits on the baseline instead of disappearing.
 *
 * ponytail: inline SVG, not a chart library. Twenty points, no axes, no legend,
 * no interaction — reach for one when this needs a second series.
 */
export function Sparkline({ values, className }: { values: number[]; className?: string }) {
  if (values.length === 0) return null;

  const width = 68;
  const height = 18;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const fraction = (v: number) => (max <= 0 ? 0 : max - min < 1e-12 ? 0.5 : v / max);

  // Half a stroke of headroom top and bottom, so the peak and the baseline are
  // both drawn rather than clipped at the viewBox edge.
  const y = (v: number) => height - 1 - fraction(v) * (height - 2);
  const x = (i: number) => (values.length === 1 ? width / 2 : (i * width) / (values.length - 1));
  const points = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      className={cn("text-muted-foreground", className)}
      role="img"
      aria-label={`share across ${values.length} window(s), peaking at ${formatPercent(max)}`}
    >
      {/* A single window is a zero-length polyline; the round cap is what makes
          it render as a dot instead of nothing at all. */}
      <polyline points={points} fill="none" stroke="currentColor" strokeWidth={1.25} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
