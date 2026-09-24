import { describe, expect, it } from "vitest";
import { composition, type GoldItem, locate, locateAll } from "./dataset.ts";

describe("composition", () => {
  it("counts items per split by category and source", () => {
    const item = (category: string, source: string, split: string) =>
      ({ category, source, split }) as GoldItem;
    const c = composition([
      item("lookup", "xbrl", "dev"),
      item("lookup", "handwritten", "test"),
      item("trend", "xbrl", "dev"),
    ]);
    expect(c.total).toEqual({ dev: 2, test: 1 });
    expect(c.categories.lookup).toEqual({ dev: 1, test: 1 });
    expect(c.categories.unanswerable).toEqual({ dev: 0, test: 0 });
    expect(c.sources.xbrl).toEqual({ dev: 2, test: 0 });
  });
});

describe("locate", () => {
  const text = "Revenue was  $130.5 billion.\nWe’re “growing”. Revenue was up.";

  it("ignores whitespace runs and curly quotes", () => {
    const hit = locate(text, 'We\'re "growing".');
    expect(hit && text.slice(hit.char_start, hit.char_end)).toBe(
      "We’re “growing”.",
    );
    const multi = locate(text, "Revenue was $130.5\nbillion.");
    expect(multi).toEqual({ char_start: 0, char_end: 28 });
  });

  it("needs a unique match unless given a position hint", () => {
    expect(locate(text, "Revenue was")).toBeNull();
    expect(locate(text, "Revenue was", { near: 40 })?.char_start).toBe(46);
    expect(locate(text, "absent")).toBeNull();
  });

  it("finds every occurrence with locateAll", () => {
    const hits = locateAll(text, "Revenue was");
    expect(hits.map((h) => h.char_start)).toEqual([0, 46]);
  });
});
