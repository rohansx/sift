import { useApi, type Exemplar, type ThemeDetail as Detail } from "@/api";
import { Failure, Pending } from "@/components/query-state";
import { ThemeStateBadge } from "@/components/state-badge";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";

/**
 * One theme: everything `sift show` prints, plus the facet line per exemplar.
 *
 * **The trace text on this page is arbitrary end-user input** — it is the most
 * attacker-influenced and most PII-dense thing sift stores. It is rendered here
 * as a React text child and nothing else: no raw-HTML escape hatch, and no
 * user-controlled value in an href, src or style anywhere on the page. The only
 * link is `#/theme/${id}` over a registry-issued SIFT-n. test/dashboard.test.ts
 * greps this whole directory for those escape hatches, because the rule has to
 * survive people who never read this comment.
 */
export function ThemeDetail({ themeId }: { themeId: string }) {
  const { data, error, loading } = useApi<Detail>(`/api/theme/${encodeURIComponent(themeId)}`);

  if (loading) return <Pending rows={3} />;
  if (error !== undefined || data === undefined) return <Failure message={error ?? "no theme"} />;
  const { theme } = data;

  return (
    <article className="flex flex-col gap-4">
      <a href="#/" className="w-fit text-xs text-muted-foreground hover:underline">
        ← all themes
      </a>

      <header className="flex flex-wrap items-center gap-3">
        <span className="font-mono text-sm tabular-nums text-muted-foreground">{theme.id}</span>
        <h2 className="text-lg font-medium">{theme.label}</h2>
        <ThemeStateBadge state={theme.state} />
      </header>

      {theme.description !== "" && <p className="max-w-3xl text-sm text-muted-foreground">{theme.description}</p>}

      <Card size="sm">
        <CardContent className="grid grid-cols-2 gap-x-6 gap-y-2 text-xs sm:grid-cols-3">
          <Fact name="facet" value={theme.facet} />
          <Fact name="agent" value={theme.agentId} />
          <Fact name="traces" value={theme.memberCount.toLocaleString("en-US")} />
          <Fact name="first window" value={theme.firstWindow ?? "—"} />
          <Fact name="last seen" value={theme.lastSeenWindow ?? "—"} />
          <Fact name="created" value={theme.createdAt.slice(0, 10)} />
          {theme.note !== undefined && <Fact name="note" value={theme.note} />}
        </CardContent>
      </Card>

      <h3 className="text-sm font-medium">
        exemplar traces{" "}
        <span className="font-normal text-muted-foreground">
          — the {data.exemplars.length} nearest the centroid, which is what the label was written from
        </span>
      </h3>
      {data.exemplars.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          no exemplar traces are still in the database; they may have been purged since this theme was discovered.
        </p>
      ) : (
        data.exemplars.map((exemplar) => <ExemplarCard key={exemplar.trace.id} exemplar={exemplar} />)
      )}

      <footer className="text-xs text-muted-foreground">
        turn this theme into an eval set:{" "}
        <code className="font-mono text-foreground">sift export {theme.id} --format mastra-scorer</code>
      </footer>
    </article>
  );
}

function Fact({ name, value }: { name: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-muted-foreground">{name}</span>
      <span className="font-mono tabular-nums break-all">{value}</span>
    </div>
  );
}

function ExemplarCard({ exemplar }: { exemplar: Exemplar }) {
  const { trace } = exemplar;
  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex flex-wrap items-center gap-2 text-xs">
          <span className="font-mono tabular-nums text-muted-foreground">{trace.id}</span>
          {trace.version !== undefined && <Badge variant="outline">{trace.version}</Badge>}
          <span className="font-normal text-muted-foreground">{trace.startedAt.slice(0, 19).replace("T", " ")}</span>
        </CardTitle>
        {exemplar.summary !== null && <p className="text-sm">{exemplar.summary}</p>}
      </CardHeader>
      <CardContent>
        {/* max-h, not h: most traces are a dozen lines, and a fixed box would
            put five empty panes on the page for every long one it fits. */}
        <ScrollArea className="max-h-64 rounded-lg border bg-muted/30">
          {/* break-all, not break-words: a trace is often one enormous JSON line
              with no spaces in it, and without this the page scrolls sideways. */}
          <pre className="p-3 font-mono text-xs whitespace-pre-wrap break-all">{trace.text}</pre>
        </ScrollArea>
        {exemplar.truncated && (
          <p className="pt-2 text-xs text-muted-foreground">
            showing the first {trace.text.length.toLocaleString("en-US")} of{" "}
            {exemplar.fullTextLength.toLocaleString("en-US")} characters; the rest was cut server-side rather than
            hidden with CSS, so it never crossed the wire.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
