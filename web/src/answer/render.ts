import { splitSentences } from "@filinglens/core";

export interface Block {
  kind: "p" | "li";
  sentences: string[];
}

const BULLET = /^\s*(?:[-*•]|\d{1,2}[.)])\s+/;

/**
 * Model output → paragraphs and list items of sentences. Deliberately tiny
 * Markdown: bullets and line breaks only, emphasis markers dropped, never HTML.
 */
export function answerBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  for (const raw of text.replace(/\*\*|__/g, "").split("\n")) {
    const line = raw.replace(/^#+\s+/, "");
    if (!line.trim()) continue;
    const bullet = BULLET.exec(line);
    const body = bullet ? line.slice(bullet[0].length) : line;
    blocks.push({
      kind: bullet ? "li" : "p",
      sentences: splitSentences(body).map((s) => body.slice(s.start, s.end)),
    });
  }
  return blocks;
}
