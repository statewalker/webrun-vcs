/**
 * `git commit-graph verify`, after git's `verify_commit_graph` and `graph_verify`: the
 * checksum, id order and fanout of each layer, each commit parsed from the graph, then each
 * commit compared with the object database (tree, parents, generation, date).
 */

import type { FilesApi } from "@statewalker/vcs-utils/files";
import { joinPath } from "@statewalker/vcs-utils/files";
import { bytesToHex } from "@statewalker/vcs-utils/hash/utils";

import type { ObjectId } from "../../common/id/index.js";
import { CommitGraph, CommitGraphCorruptError } from "./commit-graph.js";
import {
  type CommitGraphLayer,
  type CommitGraphReadSettings,
  GENERATION_NUMBER_V1_MAX,
  parseCommitGraphLayer,
} from "./commit-graph-format.js";
import { COMMIT_GRAPH_FILE, readCommitGraph, readGraphFile } from "./commit-graph-reader.js";
import type { GraphCommitData } from "./graph-commit-parse.js";

/**
 * How `verifyCommitGraph` reads a commit from the object database (no graph): its data, or a
 * promise of it (a source that has the commit in memory answers without one). `note` adds a
 * line to the verification's messages where the read happens, for what git prints while it
 * parses the commit (the grafts file's deprecation hint, on the first one).
 */
export type VerifyCommitSource = (
  id: ObjectId,
  note: (line: string) => void,
) => GraphCommitData | undefined | Promise<GraphCommitData | undefined>;

/** The outcome of a verification, as `git commit-graph verify` ends. */
export interface CommitGraphVerifyResult {
  /** git's exit status: 0 when the graph is sound (or absent), 1 or 2 (checksum only) otherwise */
  exitCode: number;
  /** What git prints on stderr, one message per line */
  messages: string[];
}

const ERROR_HASH = 2;

/** Options of {@link verifyGraph} and {@link verifyCommitGraph}. */
export interface VerifyGraphOptions {
  /** `--shallow`: only the top layer */
  shallow?: boolean;
  /**
   * The commits whose graph parent lists read as empty in the layer verified first: git reads
   * the grafts file when it parses the first commit from the object database, after it parsed
   * that layer's commits from the graph, and registering a graft unparses the grafted commit
   * (`unparse_commit`), so its parents from the graph are gone. Asked once that first commit
   * is read.
   */
  ungraphedParents?: (id: ObjectId) => boolean;
}

/**
 * Verifies a loaded graph (git's verify_commit_graph): every layer from the top down, or only
 * the top one with `shallow`.
 *
 * @example
 * ```typescript
 * const result = await verifyGraph(graph, (id) => readCommit(id));
 * if (result.exitCode) console.error(result.messages.join("\n"));
 * ```
 */
export async function verifyGraph(
  graph: CommitGraph,
  readCommit: VerifyCommitSource,
  options: VerifyGraphOptions = {},
): Promise<CommitGraphVerifyResult> {
  const messages: string[] = [];
  const state = { error: 0 };
  const report = (message: string) => {
    state.error = 1;
    messages.push(message);
  };
  let local = 0;
  try {
    for (let i = graph.layers.length - 1; i >= 0; i--) {
      const ungraphed = i === graph.layers.length - 1 ? options.ungraphedParents : undefined;
      local |= await verifyLayer(graph, i, readCommit, report, state, messages, ungraphed);
      if (options.shallow) break;
    }
  } catch (e) {
    if (e instanceof CommitGraphCorruptError) {
      messages.push(`fatal: ${e.message}`);
      return { exitCode: 128, messages };
    }
    throw e;
  }
  return { exitCode: local, messages };
}

/** git's verify_one_commit_graph for the layer at `index` (the chain up to it). */
async function verifyLayer(
  full: CommitGraph,
  index: number,
  readCommit: VerifyCommitSource,
  report: (m: string) => void,
  state: { error: number },
  messages: string[],
  ungraphedParents?: (id: ObjectId) => boolean,
): Promise<number> {
  const layer = full.layers[index] as CommitGraphLayer;
  // the graph as seen from this layer: it and the layers below
  const g =
    index === full.layers.length - 1 ? full : new CommitGraph(full.layers.slice(0, index + 1));
  const base = layer.numCommitsInBase;

  const body = layer.bytes.subarray(0, layer.bytes.length - layer.hashSize);
  if (bytesToHex(await layer.objectFormat.digest(body)) !== layer.hash) {
    report("the commit-graph file has incorrect checksum and is likely corrupt");
    state.error = ERROR_HASH;
  }

  let fanoutPos = 0;
  let prev: Uint8Array | undefined;
  const parseFailed = new Set<number>();
  for (let i = 0; i < layer.numCommits; i++) {
    const cur = layer.oidBytes(i);
    if (prev && compareBytes(prev, cur) >= 0) {
      report(`commit-graph has incorrect OID order: ${bytesToHex(prev)} then ${bytesToHex(cur)}`);
    }
    prev = cur;
    while ((cur[0] as number) > fanoutPos) {
      const value = layer.fanoutAt(fanoutPos);
      if (i !== value) {
        report(`commit-graph has incorrect fanout value: fanout[${fanoutPos}] = ${value} != ${i}`);
      }
      fanoutPos++;
    }
    try {
      g.parentPositionsAt(base + i);
    } catch (e) {
      if (!(e instanceof CommitGraphCorruptError) || !e.message.includes("extra-edges")) throw e;
      messages.push(`error: ${e.message}`);
      report(`failed to parse commit ${bytesToHex(cur)} from commit-graph`);
      parseFailed.add(i);
    }
  }
  while (fanoutPos < 256) {
    const value = layer.fanoutAt(fanoutPos);
    if (layer.numCommits !== value) {
      report(
        `commit-graph has incorrect fanout value: fanout[${fanoutPos}] = ${value} != ${layer.numCommits}`,
      );
    }
    fanoutPos++;
  }
  if (state.error & ~ERROR_HASH) return state.error;

  let seenGenZero: ObjectId | undefined;
  let seenGenNonZero: ObjectId | undefined;
  const note = (line: string) => {
    messages.push(line);
  };
  for (let i = 0; i < layer.numCommits; i++) {
    const pos = base + i;
    const id = g.idAt(pos);
    const read = readCommit(id, note);
    const odb = read instanceof Promise ? await read : read;
    if (!odb) {
      report(`failed to parse commit ${id} from object database for commit-graph`);
      continue;
    }
    const graphTree = g.treeAt(pos);
    if (graphTree !== odb.tree) {
      report(`root tree OID for commit ${id} in commit-graph is ${graphTree} != ${odb.tree}`);
    }
    const graphParents =
      parseFailed.has(i) || ungraphedParents?.(id) ? [] : g.parentPositionsAt(pos);
    let maxGeneration = 0;
    let k = 0;
    for (; k < graphParents.length; k++) {
      if (k >= odb.parents.length) {
        report(`commit-graph parent list for commit ${id} is too long`);
        break;
      }
      const parentPos = graphParents[k] as number;
      const parentId = g.idAt(parentPos);
      if (parentId !== odb.parents[k]) {
        report(`commit-graph parent for ${id} is ${parentId} != ${odb.parents[k]}`);
      }
      const generation = g.generationAt(parentPos);
      if (generation > maxGeneration) maxGeneration = generation;
    }
    if (k === graphParents.length && k < odb.parents.length) {
      report(`commit-graph parent list for commit ${id} terminates early`);
    }
    const generation = g.generationAt(pos);
    if (generation) seenGenNonZero = id;
    else seenGenZero = id;
    if (seenGenZero) continue;
    if (!layer.readGenerationData && maxGeneration === GENERATION_NUMBER_V1_MAX) maxGeneration--;
    if (generation < maxGeneration + 1) {
      report(`commit-graph generation for commit ${id} is ${generation} < ${maxGeneration + 1}`);
    }
    const date = g.commitTimeAt(pos);
    if (date !== odb.date) {
      report(`commit date for commit ${id} in commit-graph is ${date} != ${odb.date}`);
    }
  }
  if (seenGenZero && seenGenNonZero) {
    report(
      `commit-graph has both zero and non-zero generations (e.g., commits '${seenGenZero}' and '${seenGenNonZero}')`,
    );
  }
  return state.error;
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < a.length; i++) {
    const d = (a[i] as number) - (b[i] as number);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * `git commit-graph verify [--shallow]` over an object directory: opens `info/commit-graph`,
 * else the chain; no graph at all is success. A graph that does not load fails with git's
 * messages; an incomplete chain is verified as far as it loads and then fails.
 *
 * @example
 * ```typescript
 * const { exitCode, messages } = await verifyCommitGraph(files, ".git/objects", readCommit);
 * ```
 */
export async function verifyCommitGraph(
  files: FilesApi,
  objectsDir: string,
  readCommit: VerifyCommitSource,
  options: VerifyGraphOptions & {
    settings?: CommitGraphReadSettings;
    /**
     * Every object directory of the repository, its own first, then the alternates': the
     * layers of a split chain are looked up in each (default: `objectsDir` alone)
     */
    objectDirs?: readonly string[];
  } = {},
): Promise<CommitGraphVerifyResult> {
  const settings = options.settings ?? {};
  const prefix = (d: { level: string; message: string }) => `${d.level}: ${d.message}`;
  const single = joinPath(objectsDir, COMMIT_GRAPH_FILE);
  const bytes = await readGraphFile(files, single);
  let graph: CommitGraph | undefined;
  let incomplete = false;
  const messages: string[] = [];
  if (bytes) {
    // graph_verify opens info/commit-graph and does not fall back to the chain
    const diagnostics: { level: "error" | "warning"; message: string }[] = [];
    const layer = parseCommitGraphLayer(bytes, single, settings, diagnostics);
    messages.push(...diagnostics.map(prefix));
    if (!layer) return { exitCode: 1, messages };
    graph = new CommitGraph([layer]);
  } else {
    const read = await readCommitGraph(files, objectsDir, settings, options.objectDirs);
    messages.push(...read.diagnostics.map(prefix));
    if (read.opened === "none") return { exitCode: 0, messages };
    if (!read.graph) return { exitCode: 1, messages };
    graph = read.graph;
    incomplete = read.incompleteChain;
  }
  const result = await verifyGraph(graph, readCommit, options);
  messages.push(...result.messages);
  let exitCode = result.exitCode;
  if (incomplete && exitCode !== 128) {
    messages.push("error: one or more commit-graph chain files could not be loaded");
    exitCode |= 1;
  }
  return { exitCode, messages };
}
