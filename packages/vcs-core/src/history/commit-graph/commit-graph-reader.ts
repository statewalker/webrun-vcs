/**
 * Loading a repository's commit-graph from its object directory, as git's
 * `read_commit_graph_one`: `info/commit-graph` if it parses, else the split chain listed in
 * `info/commit-graphs/commit-graph-chain` (each `graph-<hash>.graph`, base first). A chain
 * that breaks off is kept up to the last layer that fits (git's incomplete chain).
 */

import type { FilesApi } from "@statewalker/vcs-utils/files";
import { joinPath, readFile } from "@statewalker/vcs-utils/files";

import { CommitGraph } from "./commit-graph.js";
import {
  type CommitGraphDiagnostic,
  type CommitGraphLayer,
  type CommitGraphReadSettings,
  HASH_SIZE,
  parseCommitGraphLayer,
} from "./commit-graph-format.js";

/** The single-file graph, relative to the object directory. */
export const COMMIT_GRAPH_FILE = "info/commit-graph";
/** The directory of split layers, relative to the object directory. */
export const COMMIT_GRAPHS_DIR = "info/commit-graphs";
/** The chain file, relative to the object directory. */
export const COMMIT_GRAPH_CHAIN_FILE = "info/commit-graphs/commit-graph-chain";

/** The file name of a split layer. */
export function splitGraphFileName(hash: string): string {
  return `${COMMIT_GRAPHS_DIR}/graph-${hash}.graph`;
}

/**
 * The bytes of the file at `path`, undefined when there is none (some FilesApis read a missing
 * file as empty instead of failing).
 */
export async function readGraphFile(
  files: FilesApi,
  path: string,
): Promise<Uint8Array | undefined> {
  if ((await files.stats(path))?.kind !== "file") return undefined;
  try {
    return await readFile(files, path);
  } catch {
    return undefined;
  }
}

/** What `readCommitGraph` found. */
export interface CommitGraphReadResult {
  /** The graph, undefined when there is none or it does not load */
  graph?: CommitGraph;
  /** Which file was opened: none, `info/commit-graph`, or the chain */
  opened: "none" | "graph" | "chain";
  /** True when the chain names a layer that could not be loaded (git's incomplete chain) */
  incompleteChain: boolean;
  /** The messages git prints while loading */
  diagnostics: CommitGraphDiagnostic[];
  /** The layer files of the loaded graph, base first (paths within `files`) */
  files: string[];
}

const HEX40 = /^[0-9a-f]{40}/;

/**
 * Reads the commit-graph of the object directory `objectsDir` (a path within `files`).
 *
 * @example
 * ```typescript
 * const { graph } = await readCommitGraph(files, ".git/objects");
 * console.log(graph?.size ?? 0, "commits in the graph");
 * ```
 */
export async function readCommitGraph(
  files: FilesApi,
  objectsDir: string,
  settings: CommitGraphReadSettings = {},
): Promise<CommitGraphReadResult> {
  const diagnostics: CommitGraphDiagnostic[] = [];
  const single = joinPath(objectsDir, COMMIT_GRAPH_FILE);
  const bytes = await readGraphFile(files, single);
  if (bytes) {
    const layer = parseCommitGraphLayer(bytes, single, settings, diagnostics);
    if (layer) {
      return {
        graph: new CommitGraph([layer]),
        opened: "graph",
        incompleteChain: false,
        diagnostics,
        files: [single],
      };
    }
  }
  const chain = await readChain(files, objectsDir, settings, diagnostics);
  return { ...chain, diagnostics };
}

/** git's load_commit_graph_chain_fd_st. */
async function readChain(
  files: FilesApi,
  objectsDir: string,
  settings: CommitGraphReadSettings,
  diagnostics: CommitGraphDiagnostic[],
): Promise<Omit<CommitGraphReadResult, "diagnostics">> {
  const chainPath = joinPath(objectsDir, COMMIT_GRAPH_CHAIN_FILE);
  const content = await readGraphFile(files, chainPath);
  const none = { opened: "none" as const, incompleteChain: false, files: [] };
  if (!content) return none;
  if (content.length < 2 * HASH_SIZE) {
    // an empty chain file is the same as none
    if (content.length > 0) {
      diagnostics.push({ level: "warning", message: "commit-graph chain file too small" });
    }
    return none;
  }
  const count = Math.floor(content.length / (2 * HASH_SIZE + 1));
  const lines = new TextDecoder().decode(content).split("\n");
  const layers: CommitGraphLayer[] = [];
  const paths: string[] = [];
  const hashes: string[] = [];
  let valid = true;
  for (let i = 0; i < count && i < lines.length; i++) {
    const line = lines[i] as string;
    if (i === lines.length - 1 && line === "") break;
    if (!HEX40.test(line)) {
      diagnostics.push({
        level: "warning",
        message: `invalid commit-graph chain: line '${line}' not a hash`,
      });
      valid = false;
      break;
    }
    hashes.push(line.slice(0, 2 * HASH_SIZE));
    const path = joinPath(objectsDir, splitGraphFileName(line));
    const bytes = await readGraphFile(files, path);
    const layer = bytes ? parseCommitGraphLayer(bytes, path, settings, diagnostics) : undefined;
    valid = layer !== undefined && addToChain(layer, layers, hashes, diagnostics);
    if (!valid) {
      diagnostics.push({ level: "warning", message: "unable to find all commit-graph files" });
      break;
    }
    layers.push(layer as CommitGraphLayer);
    paths.push(path);
  }
  validateMixedGenerationChain(layers);
  validateMixedBloomSettings(layers, diagnostics);
  return {
    graph: layers.length > 0 ? new CommitGraph(layers) : undefined,
    opened: "chain",
    incompleteChain: !valid,
    files: paths,
  };
}

/** git's add_graph_to_chain: the BASE chunk must name the layers below, in order. */
function addToChain(
  layer: CommitGraphLayer,
  chain: CommitGraphLayer[],
  hashes: string[],
  diagnostics: CommitGraphDiagnostic[],
): boolean {
  const n = chain.length;
  if (n > 0 && !layer.baseGraphs) {
    diagnostics.push({ level: "warning", message: "commit-graph has no base graphs chunk" });
    return false;
  }
  const baseSize = layer.baseGraphs?.size ?? 0;
  if (Math.floor(baseSize / HASH_SIZE) < n) {
    diagnostics.push({ level: "warning", message: "commit-graph base graphs chunk is too small" });
    return false;
  }
  for (let k = n - 1; k >= 0; k--) {
    const below = chain[k] as CommitGraphLayer;
    const at = (layer.baseGraphs?.offset ?? 0) + HASH_SIZE * k;
    let named = "";
    for (let b = 0; b < HASH_SIZE; b++) {
      named += (layer.bytes[at + b] as number).toString(16).padStart(2, "0");
    }
    if (hashes[k] !== below.hash || named !== below.hash) {
      diagnostics.push({ level: "warning", message: "commit-graph chain does not match" });
      return false;
    }
  }
  const top = chain[n - 1];
  layer.numCommitsInBase = top ? top.numCommits + top.numCommitsInBase : 0;
  return true;
}

/**
 * git's validate_mixed_generation_chain: corrected commit dates are used only when every
 * layer has GDA2. Returns whether they are.
 */
export function validateMixedGenerationChain(layers: readonly CommitGraphLayer[]): boolean {
  const all = layers.every((l) => l.readGenerationData);
  if (!all) for (const l of layers) l.readGenerationData = false;
  return all;
}

/**
 * git's validate_mixed_bloom_settings: from the top down, a layer whose filter settings differ
 * from the first layer with filters loses its filters.
 */
function validateMixedBloomSettings(
  layers: readonly CommitGraphLayer[],
  diagnostics: CommitGraphDiagnostic[],
): void {
  let settings: CommitGraphLayer["bloomSettings"];
  for (let i = layers.length - 1; i >= 0; i--) {
    const l = layers[i] as CommitGraphLayer;
    if (!l.bloomSettings) continue;
    if (!settings) {
      settings = l.bloomSettings;
      continue;
    }
    if (
      l.bloomSettings.bitsPerEntry !== settings.bitsPerEntry ||
      l.bloomSettings.numHashes !== settings.numHashes ||
      l.bloomSettings.hashVersion !== settings.hashVersion
    ) {
      l.bloomIndexes = undefined;
      l.bloomData = undefined;
      l.bloomSettings = undefined;
      diagnostics.push({
        level: "warning",
        message: `disabling Bloom filters for commit-graph layer '${l.hash}' due to incompatible settings`,
      });
    }
  }
}
