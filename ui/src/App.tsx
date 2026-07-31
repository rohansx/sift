import { useEffect, useState } from "react";

import { setToken, useApi, type Meta } from "@/api";
import { Picker } from "@/components/picker";
import { Failure, Pending } from "@/components/query-state";
import { Button } from "@/components/ui/button";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Delta } from "@/views/Delta";
import { Issues } from "@/views/Issues";
import { ThemeDetail } from "@/views/ThemeDetail";

/**
 * The whole dashboard: three screens over the read-only /api, and a hash router
 * to move between them.
 *
 * Hash routing and not history routing, and not a router library. The reason is
 * on the server: path routing needs an SPA fallback, and a fallback that turns
 * every unknown path into HTML would swallow the receiver's 404s — a mistyped
 * `/v1/trace` would answer 200 with a dashboard instead of telling an exporter
 * what sift accepts. Nothing after the `#` ever reaches the server, so every one
 * of those messages survives untouched.
 */

type Route = { screen: "issues" } | { screen: "delta" } | { screen: "theme"; themeId: string };

function parseRoute(hash: string): Route {
  const theme = /^#\/theme\/(.+)$/.exec(hash);
  if (theme) return { screen: "theme", themeId: decodeURIComponent(theme[1]!) };
  if (hash === "#/delta") return { screen: "delta" };
  return { screen: "issues" };
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
      ) : (
        <>
          <nav className="flex flex-wrap items-center justify-between gap-3">
            <Tabs value={route.screen === "delta" ? "delta" : "issues"}>
              <TabsList variant="line">
                <TabsTrigger value="issues" onClick={() => (window.location.hash = "#/")}>
                  Issues
                </TabsTrigger>
                <TabsTrigger value="delta" onClick={() => (window.location.hash = "#/delta")}>
                  Delta
                </TabsTrigger>
              </TabsList>
            </Tabs>
            <div className="flex flex-wrap items-center gap-3">
              <Picker label="agent" value={currentAgent} options={agents} onChange={setAgent} />
              <Picker label="facet" value={currentFacet} options={facets} onChange={setFacet} />
            </div>
          </nav>

          {route.screen === "theme" ? (
            <ThemeDetail themeId={route.themeId} />
          ) : route.screen === "delta" ? (
            <Delta agent={currentAgent} facet={currentFacet} />
          ) : (
            <Issues agent={currentAgent} facet={currentFacet} />
          )}
        </>
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
