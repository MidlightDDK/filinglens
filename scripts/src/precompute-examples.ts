// `pnpm examples`: precomputes the Ask page's six example chips into
// web/public/examples/{id}.json (committed), so they render instantly and work
// even when every LLM provider is down. Same path as the answers eval:
// retrieval (packages/core, WASM kernels like the browser) → the Worker's
// prompt and Groq model → the support judge. LLM calls go through the eval
// cache (evals/.cache/llm), so rerunning costs no tokens.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  buildPrompt,
  ChunkStore,
  type ExampleFile,
  JUDGE_VERSION,
  loadIndex,
  type Passage,
  PROMPT_VERSION,
  parseInsufficient,
  type RetrievalConfig,
  retrieve,
} from "@filinglens/core";
import {
  fsIndexSource,
  loadNodeEmbedder,
  REPO_ROOT,
} from "@filinglens/core/node";
import { GENERATOR_MODEL, generationRequest } from "../../evals/src/answers.ts";
import { loadGolden } from "../../evals/src/dataset.ts";
import {
  JUDGE_MODEL,
  judgeClient,
  promptSources,
  supportVerdicts,
} from "../../evals/src/judge.ts";
import { LlmClient, PROVIDERS } from "../../evals/src/llm.ts";
import { commit } from "../../evals/src/retrieval.ts";
import { EXAMPLES } from "../../web/src/ask/examples.ts";

const OUT_DIR = `${REPO_ROOT}web/public/examples`;
const config = JSON.parse(
  readFileSync(`${REPO_ROOT}evals/configs/default.json`, "utf8"),
) as RetrievalConfig;

const golden = new Map(loadGolden("dev").map((it) => [it.id, it]));
const source = fsIndexSource();
const index = await loadIndex(source, config.strategy);
const store = new ChunkStore(source, config.strategy);
const embedder = await loadNodeEmbedder("wasm");
const generator = new LlmClient(PROVIDERS.groq);
const judge = judgeClient();
const run = commit();
mkdirSync(OUT_DIR, { recursive: true });

for (const ex of EXAMPLES) {
  if (golden.get(ex.item)?.question !== ex.question) {
    throw new Error(`${ex.id}: question differs from dev item ${ex.item}`);
  }
  const result = await retrieve(index, ex.question, config, {
    embedder,
    chunks: store,
  });
  const t0 = performance.now();
  const ids = result.top.map((c) => c.chunk_id);
  const texts = await store.get(ids);
  const passages: Passage[] = result.top.flatMap((candidate) => {
    const chunk = texts.get(candidate.chunk_id);
    const doc = index.docs[candidate.doc_id];
    return chunk && doc ? [{ candidate, chunk, doc }] : [];
  });
  const fetch_ms = Math.round((performance.now() - t0) * 10) / 10;

  const sources = await promptSources(store, index.docs, ids);
  const gen = await generator.chat(
    generationRequest(buildPrompt(ex.question, sources)),
  );
  const answer = gen.content;
  const verdicts =
    parseInsufficient(answer) === null
      ? await supportVerdicts(judge, ex.question, answer, sources)
      : [];

  const file: ExampleFile = {
    id: ex.id,
    category: golden.get(ex.item)?.category ?? "",
    question: ex.question,
    created_at: new Date().toISOString(),
    commit: run,
    retrieval: {
      result,
      passages,
      fetch_ms,
      runtime: {
        model: index.meta.model,
        revision: index.meta.revision,
        dtype: index.meta.dtype,
        strategy: config.strategy,
        n: index.meta.n,
      },
    },
    answer: {
      text: answer,
      chunkIds: ids,
      done: {
        provider: "groq",
        model: GENERATOR_MODEL,
        promptVersion: PROMPT_VERSION,
        usage: gen.usage,
        latencyMs: gen.latency_ms ?? 0,
        cached: false,
      },
    },
    judge: verdicts.length
      ? {
          verdicts,
          provider: "groqJudge",
          model: JUDGE_MODEL,
          judgeVersion: JUDGE_VERSION,
          cached: false,
        }
      : null,
  };
  writeFileSync(`${OUT_DIR}/${ex.id}.json`, `${JSON.stringify(file)}\n`);
  console.log(
    `${ex.id.padEnd(14)} ${gen.cached ? "cached" : "new call"} · ${verdicts.length} verdicts`,
  );
}
