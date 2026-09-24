/** One entry of `docs.json`. */
export interface DocInfo {
  company: string;
  ticker: string;
  aliases: string[];
  fy: number;
  filing_date: string;
  url: string;
}

export type Docs = Record<string, DocInfo>;

export interface QueryFilters {
  /** Tickers named in the query (by ticker, company name, or alias). */
  tickers: string[];
  /** Fiscal years named in the query that exist for the matched companies. */
  fiscal_years: number[];
  /** "last year", "latest", "most recent": each company's latest filing. */
  latest: boolean;
  /** Allowed documents, or null when the query names no company or year. */
  doc_ids: string[] | null;
  /** Human-readable notes, e.g. a year the corpus doesn't cover. */
  notes: string[];
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const word = (s: string, flags: string) =>
  new RegExp(`(?<![A-Za-z0-9])${escapeRe(s)}(?![A-Za-z0-9])`, flags);

const LATEST =
  /\b(last|latest|most recent|this|current) (fiscal )?year\b|\b(latest|most recent)\b/i;
const YEAR =
  /\b(?:FY\s?'?|fiscal\s+(?:year\s+)?)(\d{4}|\d{2})\b|\b(20\d{2})\b/gi;

export function detectFilters(query: string, docs: Docs): QueryFilters {
  const entries = Object.entries(docs);
  const notes: string[] = [];

  const tickers = [...new Set(entries.map(([, d]) => d.ticker))]
    .filter((ticker) => {
      const d = entries.find(([, x]) => x.ticker === ticker)?.[1];
      if (!d) return false;
      if (word(ticker, "").test(query)) return true;
      return [d.company, ...d.aliases].some((name) =>
        word(name, "i").test(query),
      );
    })
    .sort();

  const years = new Set<number>();
  for (const m of query.matchAll(YEAR)) {
    const y = m[1] ?? m[2];
    if (y) years.add(y.length === 2 ? 2000 + Number(y) : Number(y));
  }
  const latest = LATEST.test(query);

  let scope = entries.filter(
    ([, d]) => tickers.length === 0 || tickers.includes(d.ticker),
  );
  let fiscal_years: number[] = [];
  if (years.size > 0) {
    const inYears = scope.filter(([, d]) => years.has(d.fy));
    fiscal_years = [...new Set(inYears.map(([, d]) => d.fy))].sort();
    const missing = [...years].filter((y) => !fiscal_years.includes(y)).sort();
    if (missing.length > 0) {
      notes.push(`No filing in the corpus for FY${missing.join(", FY")}`);
    }
    if (inYears.length > 0) scope = inYears;
  } else if (latest) {
    const maxFy = new Map<string, number>();
    for (const [, d] of scope) {
      maxFy.set(d.ticker, Math.max(maxFy.get(d.ticker) ?? 0, d.fy));
    }
    scope = scope.filter(([, d]) => d.fy === maxFy.get(d.ticker));
  }

  const filtered = tickers.length > 0 || fiscal_years.length > 0 || latest;
  return {
    tickers,
    fiscal_years,
    latest: latest && years.size === 0,
    doc_ids: filtered ? scope.map(([id]) => id).sort() : null,
    notes,
  };
}
