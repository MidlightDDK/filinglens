// Loads the index and the embedding model off the main thread, then answers
// search requests with the shared retrieval code from @filinglens/core.
import {
  ChunkStore,
  type Embedder,
  type IndexSource,
  type LoadedIndex,
  loadEmbedder,
  loadIndex,
  type RetrievalConfig,
  retrieve,
} from "@filinglens/core";
import { env, pipeline } from "@huggingface/transformers";
import defaultConfig from "../../../evals/configs/default.json";
import type { Device, WorkerRequest, WorkerResponse } from "./protocol";

const config: RetrievalConfig = defaultConfig;
env.allowLocalModels = false;

const post = (msg: WorkerResponse) => self.postMessage(msg);

const source: IndexSource = {
  json: async (path) => (await get(path)).json(),
  bytes: async (path) => (await get(path)).arrayBuffer(),
};

async function get(path: string): Promise<Response> {
  const res = await fetch(`/index/${path}`);
  if (!res.ok) throw new Error(`/index/${path}: HTTP ${res.status}`);
  return res;
}

async function pickDevice(): Promise<Device> {
  try {
    const gpu = (navigator as { gpu?: { requestAdapter(): Promise<unknown> } })
      .gpu;
    if (gpu && (await gpu.requestAdapter())) return "webgpu";
  } catch {
    // fall through to WASM
  }
  return "wasm";
}

async function loadModel(device: Device): Promise<Embedder> {
  const files = new Map<string, { loaded: number; total: number }>();
  const progress_callback = (info: unknown) => {
    const p = info as {
      status?: string;
      file?: string;
      loaded?: number;
      total?: number;
    };
    if (p.status !== "progress" || !p.file || !p.total) return;
    files.set(p.file, { loaded: p.loaded ?? 0, total: p.total });
    let loaded = 0;
    let total = 0;
    for (const f of files.values()) {
      loaded += f.loaded;
      total += f.total;
    }
    post({ type: "progress", stage: "model", fraction: loaded / total });
  };
  return loadEmbedder(pipeline, { device, progress_callback });
}

let ready: Promise<{
  index: LoadedIndex;
  embedder: Embedder;
  chunks: ChunkStore;
}> | null = null;

async function init(forced?: Device) {
  const t0 = performance.now();
  let done = 0;
  const counting: IndexSource = {
    json: async (path) => {
      const out = await source.json(path);
      post({ type: "progress", stage: "index", fraction: ++done / 6 });
      return out as never;
    },
    bytes: async (path) => {
      const out = await source.bytes(path);
      post({ type: "progress", stage: "index", fraction: ++done / 6 });
      return out;
    },
  };
  const indexP = loadIndex(counting, config.strategy);
  let device = forced ?? (await pickDevice());
  let embedder: Embedder;
  try {
    embedder = await loadModel(device);
  } catch (err) {
    if (device !== "webgpu") throw err;
    device = "wasm"; // e.g. a WebGPU adapter without the needed features
    embedder = await loadModel(device);
  }
  // Warm-up: the first inference compiles kernels.
  await embedder.embedQuery("warm-up");
  const index = await indexP;
  post({
    type: "ready",
    device,
    strategy: config.strategy,
    n: index.meta.n,
    model: index.meta.model,
    revision: index.meta.revision,
    dtype: index.meta.dtype,
    load_ms: Math.round(performance.now() - t0),
  });
  return {
    index,
    embedder,
    chunks: new ChunkStore(source, config.strategy),
  };
}

async function search(id: number, query: string) {
  if (!ready) throw new Error("search before init");
  const { index, embedder, chunks } = await ready;
  const result = await retrieve(index, query, config, { embedder, chunks });
  const t0 = performance.now();
  const texts = await chunks.get(result.top.map((c) => c.chunk_id));
  const passages = result.top.flatMap((candidate) => {
    const chunk = texts.get(candidate.chunk_id);
    const doc = index.docs[candidate.doc_id];
    return chunk && doc ? [{ candidate, chunk, doc }] : [];
  });
  const fetch_ms = Math.round((performance.now() - t0) * 10) / 10;
  post({ type: "result", id, result, passages, fetch_ms });
}

self.addEventListener("message", (e: MessageEvent<WorkerRequest>) => {
  const msg = e.data;
  if (msg.type === "init") {
    ready ??= init(msg.device);
    ready.catch((err: unknown) =>
      post({ type: "error", message: String(err) }),
    );
  } else if (msg.type === "search") {
    search(msg.id, msg.query).catch((err: unknown) =>
      post({ type: "error", id: msg.id, message: String(err) }),
    );
  }
});
