import type {
  Candidate,
  ChunkRecord,
  DocInfo,
  RetrievalResult,
} from "@filinglens/core";

export type Device = "webgpu" | "wasm";

export type WorkerRequest =
  | { type: "init"; device?: Device }
  | { type: "search"; id: number; query: string };

export interface Passage {
  candidate: Candidate;
  chunk: ChunkRecord;
  doc: DocInfo;
}

export interface ReadyInfo {
  device: Device;
  strategy: string;
  n: number;
  model: string;
  revision: string;
  dtype: string;
  load_ms: number;
}

export type WorkerResponse =
  | { type: "progress"; stage: "index" | "model"; fraction: number }
  | ({ type: "ready" } & ReadyInfo)
  | {
      type: "result";
      id: number;
      result: RetrievalResult;
      passages: Passage[];
      fetch_ms: number;
    }
  | { type: "error"; id?: number; message: string };
