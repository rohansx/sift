import { useState } from "react";

import { arrow, formatPercent } from "../../../src/report/model.ts";
import { qs, useApi, type FacetReport, type ThemeRow } from "@/api";
import { Picker } from "@/components/picker";
import { Failure, Pending } from "@/components/query-state";
import { Sparkline } from "@/components/sparkline";
import { ThemeStateBadge } from "@/components/state-badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

/**
 * The hero view: an issues list, not a chart (OVERVIEW.md §3.3).
 *
 * This is `sift report` in a browser, column for column, and the empty and
 * residual lines are copied from renderIssuesList word for word on purpose —
 * they are the ones that say what to run next, and a paraphrase would be a
 * second set of instructions to keep true.
 */
export function Issues({ agent, facet }: { agent: string; facet: string }) {
  // Undefined until someone picks: the server's default is "the latest window",
  // and hardcoding that here would need the window list to know it.
  const [chosen, setChosen] = useState<string | undefined>(undefined);
  const { data, error, loading } = useApi<FacetReport>(`/api/themes${qs({ agent, facet, window: chosen })}`);

  if (loading) return <Pending />;
  if (error !== undefined || data === undefined) return <Failure message={error ?? "no report"} />;

  const scope = [`agent: ${data.agentId}`, `facet: ${data.facet}`, data.window ? `window: ${data.window}` : null]
    .filter(Boolean)
    .join(", ");

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm">
          <span className="font-medium tracking-wide">THEMES</span>{" "}
          <span className="font-mono text-xs tabular-nums text-muted-foreground">
            ({scope}, {data.totalAssignments.toLocaleString("en-US")} traces)
          </span>
        </h2>
        {/* Changing the window refetches; it never recomputes anything locally,
            because the shares for an older window are a different query. */}
        <Picker label="window" value={data.window} options={data.windows} onChange={setChosen} />
      </div>

      {data.rows.length === 0 ? <NoThemes report={data} /> : <ThemeTable rows={data.rows} />}

      <div className="flex flex-col gap-2 text-xs">
        <p className="font-mono tabular-nums text-muted-foreground">
          ○ residual pile: {data.residualCount} traces ({formatPercent(data.residualShare)}) —{" "}
          {data.residualShare > data.rediscoverThreshold
            ? "discovery will re-run"
            : `discovery re-runs at ${formatPercent(data.rediscoverThreshold)}`}
        </p>
        {data.uncoveredTraces > 0 && <UncoveredAlert report={data} />}
      </div>
    </section>
  );
}

function ThemeTable({ rows }: { rows: ThemeRow[] }) {
  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-28">id</TableHead>
            <TableHead>label</TableHead>
            <TableHead className="text-right">share</TableHead>
            <TableHead>change</TableHead>
            <TableHead>state</TableHead>
            <TableHead className="text-right">history</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => (
            <TableRow
              key={row.id}
              // The anchor in the first cell is the real control — it is what
              // keyboard and middle-click get. This only saves the mouse from
              // having to hit it.
              onClick={() => {
                window.location.hash = `#/theme/${row.id}`;
              }}
              className="cursor-pointer"
            >
              <TableCell className="font-mono tabular-nums">
                <a href={`#/theme/${row.id}`} className="hover:underline">
                  ▸ {row.id}
                </a>
              </TableCell>
              <TableCell className="max-w-[26rem] truncate" title={row.label}>
                {row.label}
              </TableCell>
              <TableCell className="text-right font-mono tabular-nums">{formatPercent(row.share)}</TableCell>
              <TableCell className="font-mono text-xs tabular-nums text-muted-foreground">{change(row)}</TableCell>
              <TableCell>
                <ThemeStateBadge state={row.state} isNewHere={row.isNewHere} />
              </TableCell>
              <TableCell className="text-right">
                <Sparkline values={row.history} className="ml-auto" />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/** renderIssuesList's changeCell, minus the padding a terminal needs. */
function change(row: ThemeRow): string {
  if (row.previousShare === undefined) return "";
  const symbol = arrow(row.delta);
  if (symbol === "±") return `(± ${formatPercent(Math.abs(row.delta ?? 0))})`;
  return `${symbol} was ${formatPercent(row.previousShare)}`;
}

function NoThemes({ report }: { report: FacetReport }) {
  return (
    <div className="flex flex-col gap-2 py-6 text-sm text-muted-foreground">
      <p>no themes yet for facet "{report.facet}".</p>
      {report.uncoveredTraces > 0 && <UncoveredAlert report={report} />}
      <p>
        ingest traces, then run <code className="font-mono font-medium text-foreground">sift bootstrap</code> to discover
        them.
      </p>
    </div>
  );
}

/**
 * Traffic the report never saw, which is not the same thing as the residual
 * pile and is the difference between "clean release" and "nothing summarized".
 */
function UncoveredAlert({ report }: { report: FacetReport }) {
  return (
    <Alert className="border-amber-500/40 bg-amber-500/5 text-amber-700 dark:text-amber-400">
      <AlertDescription className="text-inherit">
        ⚠ {report.uncoveredTraces.toLocaleString("en-US")} traces are in no window yet — no share here counts them. run:{" "}
        <code className="font-mono">sift summarize</code>
      </AlertDescription>
    </Alert>
  );
}
