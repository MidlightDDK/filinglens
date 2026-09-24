import type { DocInfo } from "./filters.ts";
import type { ChunkRecord } from "./store.ts";

/** Bump on any change to the prompt text; cache keys and eval reports include it. */
export const PROMPT_VERSION = "answer-v2";

export const INSUFFICIENT = "INSUFFICIENT_EVIDENCE";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** One numbered source; `[n]` in the answer refers to `sources[n - 1]`. */
export interface PromptSource {
  chunk_id: string;
  chunk: ChunkRecord;
  doc: DocInfo;
}

const SYSTEM = `You answer questions about SEC 10-K annual reports using only the numbered SOURCES in the user message.

Rules:
1. Use only facts stated in SOURCES. Never use outside knowledge or guess.
2. End every sentence with the markers of the sources that support it, like [2] or [2][5].
3. Copy numbers exactly as the sources write them, with their units and fiscal year.
4. If the question assumes something the sources contradict (a false premise), do not decline: say plainly that the premise is wrong and state what the sources say, with markers.
5. If SOURCES answer only part of the question, answer that part and say what is missing.
6. Only if SOURCES contain nothing that answers the question, reply with exactly one line: ${INSUFFICIENT}: <what is missing>
7. At most 180 words unless the question asks for more. Plain sentences; no headings or tables.`;

/** Header line of a source block: company, fiscal year, item, and heading. */
export function sourceLabel({ chunk, doc }: PromptSource): string {
  const heading = chunk.heading_path.join(" > ");
  return `${doc.company} (${doc.ticker}) | FY${doc.fy} 10-K | Item ${chunk.item}${heading ? ` | ${heading}` : ""}`;
}

/** Builds the chat messages. Called only by the Worker, on trusted chunk text. */
export function buildPrompt(
  question: string,
  sources: PromptSource[],
): ChatMessage[] {
  const blocks = sources
    .map((s, i) => `[${i + 1}] ${sourceLabel(s)}\n${s.chunk.text.trim()}`)
    .join("\n\n");
  return [
    { role: "system", content: SYSTEM },
    {
      role: "user",
      content: `SOURCES:\n\n${blocks}\n\nQUESTION: ${question.trim()}`,
    },
  ];
}

/** The "what is missing" text when the model declined, else null. */
export function parseInsufficient(answer: string): string | null {
  const m = answer.trim().match(/^\**INSUFFICIENT_EVIDENCE\**:?\s*([\s\S]*)$/);
  return m ? (m[1] ?? "").trim() : null;
}
