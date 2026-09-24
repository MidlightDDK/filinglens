import { lazy, Suspense, useEffect, useState } from "react";
import { AskPage } from "./ask/AskPage";
import { REPO } from "./evals/report";
import { Link, usePath } from "./router";
import { useSearchEngine } from "./search/useSearch";

// Lab and Evals load on first visit, keeping them out of the Ask page's bundle.
const LabPage = lazy(() =>
  import("./lab/LabPage").then((m) => ({ default: m.LabPage })),
);
const EvalsPage = lazy(() =>
  import("./evals/EvalsPage").then((m) => ({ default: m.EvalsPage })),
);

const TITLES: Record<string, string> = {
  "/": "FilingLens",
  "/lab": "Pipeline Lab · FilingLens",
  "/evals": "Evals · FilingLens",
};

const navLink =
  "rounded px-1 py-0.5 text-slate-600 hover:text-slate-900 aria-[current=page]:font-medium aria-[current=page]:text-slate-900 aria-[current=page]:underline";

export function App() {
  // One search worker for all pages, so the model and index load once.
  const { load, run } = useSearchEngine();
  const path = usePath();
  const known = path in TITLES;
  // Pages stay mounted once visited, so going back keeps their results.
  const [visited, setVisited] = useState(() => new Set([path]));
  useEffect(() => {
    setVisited((v) => (v.has(path) ? v : new Set(v).add(path)));
    document.title = TITLES[path] ?? "Not found · FilingLens";
  }, [path]);
  const wide = path === "/lab" || path === "/evals";

  return (
    <div
      className={`mx-auto flex min-h-dvh flex-col gap-6 px-4 py-6 text-slate-900 sm:px-6 ${
        wide ? "max-w-6xl" : "max-w-3xl"
      }`}
    >
      <nav
        aria-label="Main"
        className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm"
      >
        <Link to="/" className={navLink}>
          Ask
        </Link>
        <Link to="/lab" className={navLink}>
          Pipeline Lab
        </Link>
        <Link to="/evals" className={navLink}>
          Evals
        </Link>
        <a
          href={REPO}
          target="_blank"
          rel="noreferrer"
          className="ml-auto rounded px-1 py-0.5 text-slate-600 hover:text-slate-900"
        >
          Source on GitHub
        </a>
      </nav>
      <main className="flex flex-col gap-6">
        <div hidden={path !== "/"}>
          <AskPage load={load} run={run} />
        </div>
        <Suspense fallback={<p className="text-slate-500">Loading…</p>}>
          {visited.has("/lab") && (
            <div hidden={path !== "/lab"}>
              <LabPage load={load} run={run} />
            </div>
          )}
          {visited.has("/evals") && (
            <div hidden={path !== "/evals"}>
              <EvalsPage />
            </div>
          )}
        </Suspense>
        {!known && (
          <div className="flex flex-col gap-2">
            <h1 className="text-2xl font-semibold">Page not found</h1>
            <p>
              <Link to="/" className="text-blue-700 underline">
                Go to the Ask page
              </Link>
            </p>
          </div>
        )}
      </main>
    </div>
  );
}
