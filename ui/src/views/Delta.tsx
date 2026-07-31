import { useState } from "react";

import { arrow, formatPercent } from "../../../src/report/model.ts";
import { qs, useApi, type DeltaReport, type FacetReport } from "@/api";
import { Picker } from "@/components/picker";
import { Failure, Pending } from "@/components/query-state";
import { SeverityBadge } from "@/components/state-badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";

/**
 * Two windows, diffed — the question someone acts on (OVERVIEW.md §3.3).
 *
 * Defaults to hiding severity "info" exactly as renderDeltaTerminal does. Every
 * theme moves a little between releases, and a list where everything is a
 * finding is a list nobody reads; the toggle is there because "nothing notable
 * changed" and "nothing changed" are different claims.
 */
export function Delta({ agent, facet }: { agent: string; facet: string }) {
  const [pair, setPair] = useState<{ from?: string; to?: string }>({});
  const [showAll, setShowAll] = useState(false);

  // The window list comes off the report rather than an endpoint of its own:
  // FacetReport.windows is already the list, and a second route would be a
  // second thing that can disagree about which windows exist.
  const meta = useApi<FacetReport>(`/api/themes${qs({ agent, facet })}`);
  const { data, error, loading } = useApi<DeltaReport>(`/api/delta${qs({ agent, facet, ...pair })}`);

  if (loading) return <Pending rows={3} />;
  if (error !== undefined || data === undefined) return <Failure message={error ?? "no delta"} />;

  const windows = meta.data?.windows ?? [data.fromWindow, data.toWindow];
  const findings = showAll ? data.findings : data.findings.filter((f) => f.severity !== "info");
  const hidden = data.findings.length - findings.length;

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm">
          <span className="font-medium tracking-wide">DELTA</span>{" "}
          <span className="font-mono text-xs tabular-nums text-muted-foreground">
            {data.facet}: {data.fromWindow} → {data.toWindow} ({data.fromTotal.toLocaleString("en-US")} →{" "}
            {data.toTotal.toLocaleString("en-US")} traces)
          </span>
        </h2>
        <div className="flex flex-wrap items-center gap-3">
          <Picker
            label="from"
            value={data.fromWindow}
            options={windows}
            onChange={(from) => setPair((p) => ({ from, to: p.to ?? data.toWindow }))}
          />
          <Picker
            label="to"
            value={data.toWindow}
            options={windows}
            onChange={(to) => setPair((p) => ({ from: p.from ?? data.fromWindow, to }))}
          />
        </div>
      </div>

      {findings.length === 0 ? (
        <p className="py-6 text-sm text-muted-foreground">nothing notable changed.</p>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-28">id</TableHead>
                <TableHead>label</TableHead>
                <TableHead className="text-right">{data.fromWindow}</TableHead>
                <TableHead className="text-right">{data.toWindow}</TableHead>
                <TableHead className="text-right">change</TableHead>
                <TableHead className="text-right">σ</TableHead>
                <TableHead>severity</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {findings.map((f) => (
                <TableRow key={f.themeId}>
                  <TableCell className="font-mono tabular-nums">
                    <a href={`#/theme/${f.themeId}`} className="hover:underline">
                      ▸ {f.themeId}
                    </a>
                  </TableCell>
                  <TableCell className="max-w-[24rem] truncate" title={f.label}>
                    {f.label}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums text-muted-foreground">
                    {formatPercent(f.fromShare)}
                  </TableCell>
                  <TableCell className="text-right font-mono tabular-nums">{formatPercent(f.toShare)}</TableCell>
                  <TableCell className="text-right font-mono tabular-nums">
                    {arrow(f.delta)}
                    {formatPercent(Math.abs(f.delta))}
                  </TableCell>
                  {/* computeDeltas reports 0σ when a theme has no history to
                      vary against; printing "0.0σ" there would read as "held
                      perfectly steady", which is the opposite of "unknown". */}
                  <TableCell className="text-right font-mono tabular-nums text-muted-foreground">
                    {f.sigmas > 0 ? f.sigmas.toFixed(1) : "—"}
                  </TableCell>
                  <TableCell>
                    <SeverityBadge severity={f.severity} />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
        <p className="font-mono tabular-nums text-muted-foreground">
          ○ residual pile: {formatPercent(data.fromResidualShare)} → {formatPercent(data.toResidualShare)}
        </p>
        {(hidden > 0 || showAll) && (
          <Button variant="ghost" size="xs" onClick={() => setShowAll((v) => !v)}>
            {showAll ? "hide unremarkable changes" : `show ${hidden} unremarkable change(s)`}
          </Button>
        )}
      </div>
    </section>
  );
}
