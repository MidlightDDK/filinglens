// Node adapters (build scripts, evals, parity tests). Never imported by the web app.
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { availableParallelism } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { type Embedder, loadEmbedder } from "./embed.ts";
import type { IndexSource } from "./store.ts";

export const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));
export const INDEX_DIR = `${REPO_ROOT}web/public/index`;
const MODEL_CACHE = `${REPO_ROOT}data/models/hf`;

export function fsIndexSource(root: string = INDEX_DIR): IndexSource {
  return {
    json: async (path) => JSON.parse(await readFile(`${root}/${path}`, "utf8")),
    bytes: async (path) => {
      const buf = await readFile(`${root}/${path}`);
      return new Uint8Array(buf).buffer;
    },
  };
}

/**
 * - `wasm`: onnxruntime-web's WASM build, the same kernels the browser runs, so
 *   query vectors (and rankings) match the browser bit for bit. Use it for queries.
 * - `native`: onnxruntime-node, ~10x faster. Use it to embed passages at index
 *   time. Its x86 int8 kernels differ slightly from WASM (cosine ~0.998 on some
 *   inputs), enough to reorder close ranks if used for queries.
 */
export type NodeRuntime = "wasm" | "native";

let loadedRuntime: NodeRuntime | null = null;

/** The pinned embedding model, cached under data/models/hf. */
export async function loadNodeEmbedder(
  runtime: NodeRuntime = "wasm",
): Promise<Embedder> {
  // Transformers.js picks its ONNX runtime once, when it is first imported.
  if (loadedRuntime && loadedRuntime !== runtime) {
    throw new Error(`this process already loaded the ${loadedRuntime} runtime`);
  }
  if (runtime === "wasm" && !loadedRuntime) {
    const ort = await import("onnxruntime-web");
    const dist = dirname(
      createRequire(import.meta.url).resolve("onnxruntime-web"),
    );
    ort.env.wasm.wasmPaths = `${pathToFileURL(dist).href}/`;
    ort.env.wasm.numThreads = Math.min(4, availableParallelism());
    (globalThis as Record<symbol, unknown>)[Symbol.for("onnxruntime")] = ort;
  }
  loadedRuntime = runtime;
  const { env, pipeline } = await import("@huggingface/transformers");
  env.cacheDir = MODEL_CACHE;
  // "auto" lets the injected runtime choose its default backend (wasm).
  return loadEmbedder(pipeline, {
    device: runtime === "wasm" ? "auto" : "cpu",
  });
}
