import { readFileSync } from "node:fs";
import { EMBEDDING_MODEL } from "@filinglens/core";
import { REPO_ROOT } from "@filinglens/core/node";
import { expect, it } from "vitest";

it("pins the same embedding model as the pipeline tokenizer", () => {
  const py = readFileSync(`${REPO_ROOT}pipeline/pipeline/tokenizer.py`, "utf8");
  const pinned = (name: string) =>
    py.match(new RegExp(`^${name} = "([^"]+)"`, "m"))?.[1];
  expect(pinned("MODEL_ID")).toBe(EMBEDDING_MODEL.id);
  expect(pinned("MODEL_REVISION")).toBe(EMBEDDING_MODEL.revision);
});

it("pins onnxruntime-web to the version Transformers.js runs in the browser", () => {
  const coreDir = `${REPO_ROOT}packages/core/`;
  const read = (path: string) => JSON.parse(readFileSync(path, "utf8"));
  const core = read(`${coreDir}package.json`);
  const transformers = read(
    `${coreDir}node_modules/@huggingface/transformers/package.json`,
  );
  expect(core.dependencies["onnxruntime-web"]).toBe(
    transformers.dependencies["onnxruntime-web"],
  );
});
