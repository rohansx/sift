import { useEffect, useState } from "react";

import { setToken, useApi, type Meta } from "@/api";
import { Picker } from "@/components/picker";
import { Failure, Pending } from "@/components/query-state";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Delta } from "@/views/Delta";
import { Issues } from "@/views/Issues";
import { ThemeDetail } from "@/views/ThemeDetail";

/**
 * The whole dashboard: three screens over the read-only /api, and a hash router
 * to move between them.
 *
 * Hash routing and not history routing, and not a router library. The reason is
 * on the server: this process is also an OTLP collector, and an SPA fallback
 * that turns every unknown path into HTML would swallow its 404s — a mistyped
 * `/v1/trace` would answer 200 with a dashboard instead of telling an exporter
 * what sift accepts. Nothing after the `#` ever reaches the server, so every one
 * of those messages survives untouched, with no route table to keep in sync.
 * The receiver does have a fallback (`isPageNavigation` in ingest/receiver.ts),
 * gated on Accept and on the collector's own prefixes so it cannot do that; it
 * catches stale bookmarks, and it is the thing that would have to be trusted if
 * this ever moved to history routing. Nothing here generates a URL that needs it.
 */

type Route = { screen: "issues" } | { screen: "delta" } | { screen: "theme"; themeId: string };

function parseRoute(hash: string): Route {
  const theme = /^#\/theme\/(.+)$/.exec(hash);
  if (theme) return { screen: "theme", themeId: decodeSegment(theme[1]!) };
  if (hash === "#/delta") return { screen: "delta" };
  return { screen: "issues" };
}

/**
 * decodeURIComponent throws URIError on a malformed escape ("#/theme/100%"),
 * and this runs inside a render — an unhandled throw there unmounts the tree and
 * leaves a blank page. The raw segment misses the lookup and 404s instead, which
 * is the same call src/serve/api.ts makes about the server-side id.
 */
function decodeSegment(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parseRoute(window.location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

export default function App() {
  const route = useRoute();
  const meta = useApi<Meta>("/api/meta");
  const [agent, setAgent] = useState<string | undefined>(undefined);
  const [facet, setFacet] = useState<string | undefined>(undefined);

  if (meta.unauthorized) return <TokenGate />;
  if (meta.loading) return <Shell>{<Pending rows={4} />}</Shell>;
  if (meta.error !== undefined || meta.data === undefined) {
    return <Shell>{<Failure message={meta.error ?? "no /api/meta"} />}</Shell>;
  }

  const { agents, facets, dbPath } = meta.data;
  // The server defaults to the first of each when the query omits them; picking
  // the same defaults here keeps the pickers showing what is actually on screen.
  const currentAgent = agent ?? agents[0];
  const currentFacet = facet ?? facets[0];

  return (
    <Shell dbPath={dbPath}>
      {currentAgent === undefined || currentFacet === undefined ? (
        <Empty dbPath={dbPath} />
      ) : route.screen === "theme" ? (
        // No tablist here: a theme page is not one of the tabs, and a tablist
        // showing "Issues" selected while a theme is on screen is a lie to a
        // screen reader. The page carries its own "← all themes" link.
        <ThemeDetail themeId={route.themeId} />
      ) : (
        // The screens live inside <Tabs> so each trigger's aria-controls points
        // at a real tabpanel, and onValueChange is what makes arrow keys move
        // the selection rather than only the focus: Radix activates on arrow by
        // default, and a controlled value with no handler throws that away.
        <Tabs
          value={route.screen}
          onValueChange={(value) => {
            window.location.hash = value === "delta" ? "#/delta" : "#/";
          }}
          className="gap-5"
        >
          <nav className="flex flex-wrap items-center justify-between gap-3">
            <TabsList variant="line">
              <TabsTrigger value="issues">Issues</TabsTrigger>
              <TabsTrigger value="delta">Delta</TabsTrigger>
            </TabsList>
            <div className="flex flex-wrap items-center gap-3">
              <Picker label="agent" value={currentAgent} options={agents} onChange={setAgent} />
              <Picker label="facet" value={currentFacet} options={facets} onChange={setFacet} />
            </div>
          </nav>

          {/* Keyed by the scope, so changing agent or facet remounts the screen.
              A chosen window (or a from/to pair) belongs to the scope it was
              picked in; carried across, it 404s on a window the new scope does
              not have, and the picker that could undo it is below the error. */}
          <TabsContent value="issues">
            <Issues key={`${currentAgent}/${currentFacet}`} agent={currentAgent} facet={currentFacet} />
          </TabsContent>
          <TabsContent value="delta">
            <Delta key={`${currentAgent}/${currentFacet}`} agent={currentAgent} facet={currentFacet} />
          </TabsContent>
        </Tabs>
      )}
    </Shell>
  );
}

function Shell({ children, dbPath }: { children: React.ReactNode; dbPath?: string }) {
  return (
    <div className="mx-auto flex min-h-svh max-w-6xl flex-col gap-5 p-5 sm:p-8">
      <header className="flex flex-wrap items-baseline gap-3 border-b pb-3">
        <a href="#/" className="font-mono text-base font-medium">
          sift
        </a>
        <span className="text-xs text-muted-foreground">read-only. resolve, mute and relabel live in the CLI.</span>
        {dbPath !== undefined && (
          <span className="ml-auto font-mono text-xs break-all text-muted-foreground">{dbPath}</span>
        )}
      </header>
      {children}
    </div>
  );
}

function Empty({ dbPath }: { dbPath: string }) {
  return (
    <div className="flex flex-col gap-2 py-8 text-sm text-muted-foreground">
      <p>
        no traces in <code className="font-mono">{dbPath}</code> yet.
      </p>
      <p>
        point an exporter at this server, or run{" "}
        <code className="font-mono text-foreground">sift analyze --otlp ./traces.jsonl</code>, then reload.
      </p>
    </div>
  );
}

/**
 * What a `--token` server shows before it shows anything else.
 *
 * The page itself is served unauthenticated (a browser cannot put a bearer on a
 * navigation), so without this a tokened server renders a blank shell and an
 * unexplained 401 in the console. Opening the URL as `?token=...` skips it.
 */
function TokenGate() {
  const [value, setValue] = useState("");
  return (
    <Shell>
      <form
        className="flex max-w-md flex-col gap-3 py-8"
        onSubmit={(e) => {
          e.preventDefault();
          setToken(value);
          window.location.reload();
        }}
      >
        <p className="text-sm">
          This sift server was started with <code className="font-mono">--token</code>. Paste it to read the database.
        </p>
        <input
          type="password"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          autoComplete="off"
          placeholder="token"
          className="h-8 rounded-lg border border-input bg-transparent px-2.5 font-mono text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
        />
        <Button type="submit" className="w-fit">
          Unlock
        </Button>
        <p className="text-xs text-muted-foreground">
          Kept in sessionStorage for this tab only, and never written to the URL.
        </p>
      </form>
    </Shell>
  );
}
