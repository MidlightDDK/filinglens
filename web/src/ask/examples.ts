// The six example chips on the Ask page. `pnpm examples` precomputes each one
// into web/public/examples/{id}.json. Every question is a dev-split eval item
// (`item`) the answers eval scored correct, so its numbers are checked.
export const EXAMPLES = [
  {
    id: "lookup",
    item: "syn-lookup-5c55eb2c",
    kind: "Lookup",
    title: "Intel's bonus-linked emissions target",
    question:
      "What specific greenhouse gas emissions reduction target did Intel link to executive and employee performance bonuses in fiscal year 2024?",
  },
  {
    id: "table-number",
    item: "xbrl-value-googl-fy2025-revenue",
    kind: "Table number",
    title: "Alphabet's FY2025 revenue",
    question: "What was Alphabet's total revenue for fiscal year 2025?",
  },
  {
    id: "comparison",
    item: "xbrl-compare-aapl-amzn-fy2025-eps_diluted",
    kind: "Comparison",
    title: "Apple vs. Amazon diluted EPS",
    question:
      "Which company reported higher diluted earnings per share for fiscal year 2025, Apple or Amazon, and by how much?",
  },
  {
    id: "trend",
    item: "xbrl-yoy-nvda-fy2025-rd",
    kind: "Trend",
    title: "NVIDIA R&D, FY2024 to FY2025",
    question:
      "How did NVIDIA's research and development expense change from fiscal year 2024 to fiscal year 2025?",
  },
  {
    id: "false-premise",
    item: "hand-fp-aapl-sales-fall-fy2025",
    kind: "False premise",
    title: "Why did Apple's sales fall?",
    question: "Why did Apple's total net sales fall in fiscal year 2025?",
  },
  {
    id: "out-of-scope",
    item: "hand-ua-meta-ceo-salary-2025",
    kind: "Out of scope",
    title: "Mark Zuckerberg's salary",
    question: "What was Mark Zuckerberg's base salary in 2025?",
  },
] as const;

export type Example = (typeof EXAMPLES)[number];
