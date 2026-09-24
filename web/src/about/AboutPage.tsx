import type { ReactNode } from "react";
import { REPO } from "../evals/report";
import { Link } from "../router";

interface Stage {
  title: string;
  where: string;
  steps: string[];
}

// The request path, left to right (top to bottom on phones).
const STAGES: Stage[] = [
  {
    title: "Build (offline, once)",
    where: "Python + Node on a laptop or in CI",
    steps: [
      "Download 24 10-K filings from SEC EDGAR",
      "Parse into Items and sections; split into structure-aware chunks",
      "Embed chunks (bge-small, q8) and build a BM25 index",
      "Ship both as static files next to the app",
    ],
  },
  {
    title: "Retrieve (your browser)",
    where: "Web Worker, WebGPU or WASM",
    steps: [
      "Read company and fiscal-year filters from the question",
      "Embed the question with the same model",
      "BM25 + dense search, fused with Reciprocal Rank Fusion",
      "Send the top passage ids to the gateway",
    ],
  },
  {
    title: "Answer (Cloudflare Worker)",
    where: "Turnstile session, rate limit, KV cache",
    steps: [
      "Load passage text from its own copy of the index",
      "Prompt: cite a passage for every sentence, or decline",
      "Stream from Workers AI, then Groq, then Gemini as fallbacks",
    ],
  },
  {
    title: "Verify (your browser)",
    where: "Same code as the evals",
    steps: [
      "Check each sentence's citations and numbers against the cited passages",
      "Mark it verified or unverified; an optional AI judge can flag unsupported ones",
    ],
  },
];

const FREE: [string, string][] = [
  ["Hosting, gateway, answer cache", "Cloudflare Workers + KV free tier"],
  ["Answers", "Workers AI free allocation, Groq and Gemini free tiers"],
  ["Bot check", "Cloudflare Turnstile (free)"],
  ["Search and embeddings", "Your browser: no server-side vector database"],
  ["Model and runtime downloads", "Hugging Face and jsDelivr (public CDNs)"],
  ["CI, evals, daily smoke test", "GitHub Actions on a public repo"],
  ["Filings", "SEC EDGAR (public data)"],
];

function Section({
  id,
  title,
  children,
}: {
  id: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <h2 id={id} className="text-xl font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

export function AboutPage() {
  const ext = "text-blue-700 underline";
  return (
    <div className="flex flex-col gap-10">
      <header className="flex flex-col gap-2">
        <h1 className="text-3xl font-semibold tracking-tight">About</h1>
        <p className="text-slate-700">
          FilingLens answers questions about 10-K annual reports and shows its
          work: every sentence cites a passage, sentences the cited text doesn't
          back up are flagged, and questions the filings can't answer are
          declined. Retrieval choices were picked by measured quality on{" "}
          <Link to="/evals" className={ext}>
            a fixed eval set
          </Link>
          , and the{" "}
          <Link to="/lab" className={ext}>
            Pipeline Lab
          </Link>{" "}
          lets you compare them yourself.
        </p>
      </header>

      <Section id="architecture" title="How it works">
        <ol className="grid gap-3 md:grid-cols-4">
          {STAGES.map((s, i) => (
            <li
              key={s.title}
              className="relative flex flex-col gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3"
            >
              <h3 className="font-medium">
                <span className="mr-1 text-slate-500">{i + 1}.</span>
                {s.title}
              </h3>
              <p className="text-xs text-slate-500">{s.where}</p>
              <ul className="list-disc pl-4 text-sm text-slate-700">
                {s.steps.map((step) => (
                  <li key={step}>{step}</li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
        <p className="text-sm text-slate-700">
          The example questions on the Ask page were answered ahead of time by
          this same pipeline, so they show instantly and cost nothing.
        </p>
      </Section>

      <Section id="free" title="How this runs for $0">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-300">
              <th className="py-1.5 pr-3 font-medium">What</th>
              <th className="py-1.5 font-medium">Runs on</th>
            </tr>
          </thead>
          <tbody>
            {FREE.map(([what, on]) => (
              <tr key={what} className="border-b border-slate-100">
                <td className="py-1.5 pr-3">{what}</td>
                <td className="py-1.5">{on}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="text-sm text-slate-700">
          No service here needed a payment method. When a free quota runs out,
          the gateway moves to the next provider; when all are spent, you get a
          message saying so, and the example answers keep working.
        </p>
      </Section>

      <Section id="links" title="Links">
        <ul className="list-disc pl-5 text-slate-700">
          <li>
            <a href={REPO} className={ext} target="_blank" rel="noreferrer">
              Source code on GitHub
            </a>
          </li>
          <li>
            <a
              href={`${REPO}#readme`}
              className={ext}
              target="_blank"
              rel="noreferrer"
            >
              Write-up: design decisions, what didn't work, eval methodology
            </a>
          </li>
        </ul>
      </Section>
    </div>
  );
}
