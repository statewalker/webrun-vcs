/**
 * Server Fetch FSM (upload-pack) - handles Git fetch requests from the server perspective.
 *
 * Protocol flow:
 * 1. Send refs advertisement
 * 2. Read wants from client
 * 3. Validate wants against policy
 * 4. Handle shallow negotiation
 * 5. Negotiate with haves/acks
 * 6. Send pack
 */

import {
  getConfig,
  getOutput,
  getRefStore,
  getRepository,
  getState,
  getTransport,
  type ProcessContext,
  setRepository,
} from "../../context/context-adapters.js";
import { ZERO_OID } from "../../protocol/constants.js";
import { visibleRefs } from "../../protocol/hidden-refs.js";
import type { FsmStateHandler, FsmTransition } from "../types.js";
import { sendPackStream } from "./send-pack-stream.js";
import {
  computeShallowUpdate,
  findUnreachableWant,
  okToGiveUp as graphOkToGiveUp,
  notOurRef,
  peelFully,
  resolveDeepenNot,
  UploadPackRequestError,
  withServedShallow,
} from "./upload-pack-graph.js";
import {
  authorizeUpload,
  includeTagCandidates,
  notifyUpload,
  type UploadPackRequestParts,
} from "./upload-pack-hooks.js";

/**
 * Server fetch FSM transitions.
 */
export const serverFetchTransitions: FsmTransition[] = [
  // Entry point
  ["", "START", "SEND_ADVERTISEMENT"],

  // Send refs to client
  ["SEND_ADVERTISEMENT", "REFS_SENT", "READ_WANTS"],
  ["SEND_ADVERTISEMENT", "EMPTY_REPO", ""], // Empty repo → exit (client will disconnect)
  ["SEND_ADVERTISEMENT", "ERROR", ""],

  // Read wants from client
  ["READ_WANTS", "WANTS_RECEIVED", "VALIDATE_WANTS"],
  ["READ_WANTS", "WANTS_WITH_SHALLOW", "VALIDATE_WANTS"], // Wants + shallow info
  ["READ_WANTS", "NO_WANTS", ""], // client has everything
  ["READ_WANTS", "INVALID_REQUEST", "SEND_ERROR"], // a deepen line git refuses
  ["READ_WANTS", "ERROR", ""],

  // Validate wants against policy (ADVERTISED, REACHABLE_COMMIT, TIP, ANY)
  ["VALIDATE_WANTS", "VALID", "READ_SHALLOW_INFO"],
  ["VALIDATE_WANTS", "INVALID_WANT", "SEND_ERROR"], // Want not allowed by policy
  ["VALIDATE_WANTS", "ERROR", ""],

  // Send error to client
  ["SEND_ERROR", "ERROR_SENT", ""],

  // Read shallow info from client (if shallow capability)
  ["READ_SHALLOW_INFO", "SHALLOW_RECEIVED", "COMPUTE_SHALLOW"],
  ["READ_SHALLOW_INFO", "NO_SHALLOW", "READ_HAVES"], // No shallow, go to haves
  ["READ_SHALLOW_INFO", "ERROR", ""],

  // Compute shallow boundaries
  ["COMPUTE_SHALLOW", "SHALLOW_COMPUTED", "SEND_SHALLOW_UPDATE"],
  ["COMPUTE_SHALLOW", "SHALLOW_REGISTERED", "READ_HAVES"], // shallow client, no deepen
  ["COMPUTE_SHALLOW", "INVALID_REQUEST", "SEND_ERROR"],
  ["COMPUTE_SHALLOW", "ERROR", ""],

  // Send shallow/unshallow to client
  ["SEND_SHALLOW_UPDATE", "SHALLOW_SENT", "READ_HAVES"],
  ["SEND_SHALLOW_UPDATE", "ERROR", ""],

  // Read filter specification (partial clone)
  ["READ_WANTS", "WANTS_WITH_FILTER", "READ_FILTER"],
  ["READ_FILTER", "FILTER_RECEIVED", "VALIDATE_WANTS"],
  ["READ_FILTER", "ERROR", ""],

  // Read a batch of haves (each answered as it is read, as git's get_common_commits)
  ["READ_HAVES", "DONE_RECEIVED", "SEND_FINAL_ACK"], // client sent done
  ["READ_HAVES", "FLUSH_RECEIVED", "SEND_ACKS"], // End of have batch
  // stateless-rpc (smart HTTP): the request ends after a batch; its answer was sent
  ["READ_HAVES", "REQUEST_END", ""],
  ["READ_HAVES", "ERROR", ""],

  // The end of a batch: "ACK <last> ready" when it may give up, NAK in multi_ack modes
  ["SEND_ACKS", "SENT_NAK", "READ_HAVES"], // more haves (or, stateless, the request ends)
  ["SEND_ACKS", "SENT_ACK_READY", "SEND_PACK"], // no-done after "ready": NAK, ACK <last>
  ["SEND_ACKS", "ERROR", ""],

  // Send final ACK after done
  ["SEND_FINAL_ACK", "ACK_SENT", "SEND_PACK"],
  ["SEND_FINAL_ACK", "NAK_SENT", "SEND_PACK"], // clone case
  ["SEND_FINAL_ACK", "ERROR", ""],

  // Send pack data
  ["SEND_PACK", "PACK_SENT", ""], // exit
  ["SEND_PACK", "SIDEBAND_ERROR", ""], // Error sent on channel 3
  ["SEND_PACK", "ERROR", ""],
];

/** What upload-pack's negotiation keeps between haves (git's get_common_commits locals). */
interface Negotiation {
  /** A have of this batch is ours */
  gotCommon?: boolean;
  /** A have of this batch is not */
  gotOther?: boolean;
  /** "ACK <oid> ready" was sent */
  sentReady?: boolean;
  /** This batch carried a have */
  batchHaves?: boolean;
  /** ok_to_give_up for a common set of this size (it only changes when the set grows) */
  giveUp?: { size: number; ready: boolean };
}

function negotiationOf(ctx: ProcessContext): Negotiation {
  const state = getState(ctx) as unknown as { negotiation?: Negotiation };
  state.negotiation ??= {};
  return state.negotiation;
}

/** git's ok_to_give_up over the wants and the common commits found so far (memoized). */
async function okToGiveUp(ctx: ProcessContext): Promise<boolean> {
  const state = getState(ctx);
  const negotiation = negotiationOf(ctx);
  const size = state.commonBase.size;
  if (negotiation.giveUp?.size === size) return negotiation.giveUp.ready;
  const ready = await graphOkToGiveUp(getRepository(ctx), state.wants, state.commonBase);
  negotiation.giveUp = { size, ready };
  return ready;
}

/**
 * The served repository's own shallow commits (git's `is_repository_shallow`), read once per
 * session; when there are any, the context's repository becomes their grafted view
 * (`withServedShallow`: walks and packs stop at them).
 */
export async function prepareServedShallow(ctx: ProcessContext): Promise<ReadonlySet<string>> {
  const state = getState(ctx);
  if (!state.repositoryShallow) {
    state.repositoryShallow = new Set((await getRefStore(ctx).getShallow?.()) ?? []);
  }
  const repository = getRepository(ctx);
  const served = withServedShallow(repository, state.repositoryShallow);
  if (served !== repository) setRepository(ctx, served);
  return state.repositoryShallow;
}

/** The v0 request as upload-pack's hooks see it. */
function uploadRequest(ctx: ProcessContext): UploadPackRequestParts {
  const state = getState(ctx);
  return {
    protocolVersion: 0,
    wants: [...state.wants],
    wantRefs: new Map(),
    haves: [...state.haves],
    capabilities: new Set(state.capabilities),
    shallow: [...(state.clientShallow ?? [])],
    depth: state.deepen ?? 0,
    ...(state.deepenSince !== undefined ? { deepenSince: state.deepenSince } : {}),
    deepenNot: [...(state.deepenNot ?? [])],
    ...(state.filterSpec !== undefined ? { filter: state.filterSpec } : {}),
  };
}

/**
 * What upload-pack (protocol v0/v1) advertises by default: only what it implements. The
 * `allow-*-sha1-in-want` capabilities follow the request policy; `deepen-since`, `deepen-not`
 * and `deepen-relative` need the commit graph (`getCommitInfo`); no `filter` (no partial
 * clone).
 */
export function defaultUploadPackCapabilities(
  policy: string | undefined,
  repository: { getCommitInfo?: unknown },
): string[] {
  const capabilities = [
    "multi_ack",
    "multi_ack_detailed",
    "side-band-64k",
    "thin-pack",
    "no-done",
    "ofs-delta",
    "shallow",
  ];
  if (repository.getCommitInfo) capabilities.push("deepen-since", "deepen-not", "deepen-relative");
  capabilities.push("no-progress", "include-tag");
  if (policy === "TIP" || policy === "REACHABLE_COMMIT_TIP" || policy === "ANY") {
    capabilities.push("allow-tip-sha1-in-want");
  }
  if (policy === "REACHABLE_COMMIT" || policy === "REACHABLE_COMMIT_TIP" || policy === "ANY") {
    capabilities.push("allow-reachable-sha1-in-want");
  }
  return capabilities;
}

/**
 * The capabilities a client's first `want` line requests, limited to the advertised ones when
 * the server knows them (a client may not turn on what the server did not offer).
 */
export function requestedCapabilities(
  requested: string[],
  advertised: ReadonlySet<string>,
): Set<string> {
  const names = requested.filter((c) => c.length > 0);
  if (advertised.size === 0) return new Set(names);
  const offered = new Set([...advertised].map((c) => c.split("=")[0]));
  return new Set(names.filter((c) => offered.has(c.split("=")[0]) || c.startsWith("agent=")));
}

/**
 * Server fetch FSM handlers.
 */
export const serverFetchHandlers = new Map<string, FsmStateHandler<ProcessContext>>([
  // Initial handler
  ["", async () => "START"],

  // Send advertisement to client
  [
    "SEND_ADVERTISEMENT",
    async (ctx) => {
      const transport = getTransport(ctx);
      const refStore = getRefStore(ctx);
      const config = getConfig(ctx);
      const state = getState(ctx);
      const output = getOutput(ctx);
      try {
        const repositoryShallow = await prepareServedShallow(ctx);
        const repository = getRepository(ctx);
        const refs = await refStore.listAll();
        const capabilities =
          config.serverCapabilities ??
          defaultUploadPackCapabilities(config.requestPolicy, repository);

        let first = true;
        // hidden refs are neither advertised nor "ours" under the ADVERTISED policy
        const refsArray = visibleRefs(refs, config.hiddenRefs);

        // Empty repository: send special capabilities^{} line
        if (refsArray.length === 0) {
          await transport.writeLine(`${ZERO_OID} capabilities^{}\0${capabilities.join(" ")}`);
          for (const oid of repositoryShallow) await transport.writeLine(`shallow ${oid}`);
          await transport.writeFlush();
          state.advertisedCapabilities = new Set(capabilities);
          return "EMPTY_REPO";
        }

        for (const [name, oid] of refsArray) {
          const line = first ? `${oid} ${name}\0${capabilities.join(" ")}` : `${oid} ${name}`;
          await transport.writeLine(line);
          // annotated tags are followed by their peeled line, as git advertises them
          const peeled = await peelFully(repository, oid);
          if (peeled) await transport.writeLine(`${peeled} ${name}^{}`);
          state.refs.set(name, oid);
          first = false;
        }
        // git's advertise_shallow_grafts: a shallow repository's shallow commits after the refs
        for (const oid of repositoryShallow) await transport.writeLine(`shallow ${oid}`);
        await transport.writeFlush();
        state.advertisedCapabilities = new Set(capabilities);
        return "REFS_SENT";
      } catch (e) {
        output.error = String(e);
        return "ERROR";
      }
    },
  ],

  // Read wants from client
  [
    "READ_WANTS",
    async (ctx) => {
      const transport = getTransport(ctx);
      const state = getState(ctx);
      const output = getOutput(ctx);

      try {
        // a stateless request starts here (its advertisement was another request)
        await prepareServedShallow(ctx);
        let hasShallow = false;
        let hasFilter = false;

        while (true) {
          const pkt = await transport.readPktLine();

          if (pkt.type === "flush") {
            if (state.wants.size === 0) return "NO_WANTS";
            if (hasFilter) return "WANTS_WITH_FILTER";
            if (hasShallow) return "WANTS_WITH_SHALLOW";
            return "WANTS_RECEIVED";
          }
          if (pkt.type === "eof") {
            output.error = "Unexpected end of input";
            return "ERROR";
          }
          if (pkt.type === "delim") {
            continue; // Unexpected delimiter in v1 wants
          }

          // Type narrowing: pkt.type === "data" guaranteed here
          const line = pkt.text;

          if (line.startsWith("want ")) {
            const parts = line.trim().split(" ");
            const oid = parts[1];
            // The first want carries the client's capabilities, possibly none: from here on
            // they are what the pack is written for (thin-pack, ofs-delta, side-band), never
            // the advertised ones. Capabilities on later wants are ignored.
            if (state.wants.size === 0) {
              state.capabilities = requestedCapabilities(
                parts.slice(2),
                state.advertisedCapabilities,
              );
              // v0 asks for a relative deepen with a capability (v2 with an argument line)
              if (state.capabilities.has("deepen-relative")) state.deepenRelative = true;
            }
            state.wants.add(oid);
          } else if (line.startsWith("shallow ")) {
            hasShallow = true;
            const oid = line.slice(8);
            state.clientShallow = state.clientShallow ?? new Set();
            state.clientShallow.add(oid);
          } else if (line.startsWith("deepen ")) {
            // git's process_deepen
            const depth = Number(line.slice(7));
            if (!Number.isInteger(depth) || depth <= 0) {
              output.error = `Invalid deepen: ${line}`;
              return "INVALID_REQUEST";
            }
            hasShallow = true;
            state.deepen = depth;
            state.deepenRequest = line;
          } else if (line.startsWith("deepen-since ")) {
            // git's process_deepen_since: 0 (and -1) are refused
            const since = Number(line.slice(13));
            if (!Number.isInteger(since) || since <= 0) {
              output.error = `Invalid deepen-since: ${line}`;
              return "INVALID_REQUEST";
            }
            hasShallow = true;
            state.deepenSince = since;
            state.deepenRequest = line;
          } else if (line.startsWith("deepen-not ")) {
            hasShallow = true;
            state.deepenNot = [...(state.deepenNot ?? []), line.slice(11)];
            state.deepenRequest = line;
          } else if (line === "deepen-relative") {
            state.deepenRelative = true;
          } else if (line.startsWith("filter ")) {
            hasFilter = true;
            state.filterSpec = line.slice(7);
          }
        }
      } catch (e) {
        output.error = String(e);
        return "ERROR";
      }
    },
  ],

  // Validate wants against request policy
  [
    "VALIDATE_WANTS",
    async (ctx) => {
      const config = getConfig(ctx);
      const state = getState(ctx);
      const output = getOutput(ctx);
      const repository = getRepository(ctx);
      const refStore = getRefStore(ctx);

      try {
        const policy = config.requestPolicy ?? "ADVERTISED";
        // reachability counts hidden tips too, as git's allowReachableSHA1InWant
        const reachableFrom = config.hiddenRefs?.length
          ? [...(await refStore.listAll())].map(([, oid]) => oid)
          : [...state.refs.values()];

        for (const oid of state.wants) {
          let valid = false;

          switch (policy) {
            case "ADVERTISED":
              // Only advertised refs are allowed
              valid = [...state.refs.values()].includes(oid);
              break;
            case "REACHABLE_COMMIT":
              // Reachable from any advertised ref
              if (repository.getCommitInfo) {
                valid = !(await findUnreachableWant(repository, [oid], reachableFrom));
              } else if (repository.isReachableFrom) {
                valid = await repository.isReachableFrom(oid, reachableFrom);
              } else {
                valid = [...state.refs.values()].includes(oid);
              }
              break;
            case "TIP":
              // Any ref tip (including unadvertised)
              if (refStore.isRefTip) {
                valid = await refStore.isRefTip(oid);
              } else {
                valid = [...state.refs.values()].includes(oid);
              }
              break;
            case "REACHABLE_COMMIT_TIP":
              // Reachable from any ref tip (a shallow repository's grafted view withholds
              // isReachableFromAnyTip: its graph is walked from the ref store's tips)
              if (repository.isReachableFromAnyTip) {
                valid = await repository.isReachableFromAnyTip(oid);
              } else if (repository.getCommitInfo) {
                const tips = [...(await refStore.listAll())].map(([, id]) => id);
                valid = !(await findUnreachableWant(repository, [oid], tips));
              } else {
                valid = [...state.refs.values()].includes(oid);
              }
              break;
            case "ANY":
              // Any object in repository
              valid = await repository.has(oid);
              break;
          }

          if (!valid) {
            output.error = notOurRef(oid);
            output.invalidWant = oid;
            return "INVALID_WANT";
          }
        }
        // the authorize hook decides before any negotiation or pack byte
        const refused = await authorizeUpload(config, refStore, repository, uploadRequest(ctx));
        if (refused !== undefined) {
          output.error = refused;
          return "INVALID_WANT";
        }
        return "VALID";
      } catch (e) {
        output.error = String(e);
        return "ERROR";
      }
    },
  ],

  // Send error to client
  [
    "SEND_ERROR",
    async (ctx) => {
      const transport = getTransport(ctx);
      const output = getOutput(ctx);

      try {
        await transport.writeLine(`ERR ${output.error}`);
        output.errorReported = true;
        return "ERROR_SENT";
      } catch (e) {
        output.error = String(e);
        return "ERROR";
      }
    },
  ],

  // Read filter specification
  [
    "READ_FILTER",
    async (ctx) => {
      const transport = getTransport(ctx);
      const state = getState(ctx);
      const output = getOutput(ctx);

      try {
        while (true) {
          const pkt = await transport.readPktLine();
          if (pkt.type === "flush") return "FILTER_RECEIVED";
          if (pkt.type === "eof") {
            output.error = "Unexpected end of input";
            return "ERROR";
          }
          if (pkt.type === "delim") {
            continue; // Unexpected delimiter in filter section
          }

          // Type narrowing: pkt.type === "data" guaranteed here
          const line = pkt.text;
          if (line.startsWith("filter ")) {
            state.filterSpec = line.slice(7);
          }
        }
      } catch (e) {
        output.error = String(e);
        return "ERROR";
      }
    },
  ],

  // Read shallow info from client
  [
    "READ_SHALLOW_INFO",
    async (ctx) => {
      const state = getState(ctx);
      const output = getOutput(ctx);

      try {
        // Already parsed in READ_WANTS if present
        if (!state.clientShallow?.size && !state.deepenRequest) {
          return "NO_SHALLOW";
        }
        return "SHALLOW_RECEIVED";
      } catch (e) {
        output.error = String(e);
        return "ERROR";
      }
    },
  ],

  // Compute the shallow update, as git's send_shallow_list (computeShallowUpdate): the new
  // shallow commits, the client's ones now unshallowed, and how the pack is cut
  [
    "COMPUTE_SHALLOW",
    async (ctx) => {
      const state = getState(ctx);
      const output = getOutput(ctx);
      const repository = getRepository(ctx);
      const refStore = getRefStore(ctx);

      try {
        const deepenNot: string[] = [];
        for (const name of state.deepenNot ?? []) {
          const oid = await resolveDeepenNot(refStore, name);
          if (!oid) {
            output.error = `git upload-pack: ambiguous deepen-not: deepen-not ${name}`;
            return "INVALID_REQUEST";
          }
          deepenNot.push(oid);
        }
        const deepening =
          (state.deepen ?? 0) > 0 || state.deepenSince !== undefined || deepenNot.length > 0;
        const update = await computeShallowUpdate(repository, {
          wants: state.wants,
          clientShallow: state.clientShallow ?? [],
          depth: state.deepen,
          deepenRelative: state.deepenRelative,
          deepenSince: state.deepenSince,
          deepenNot,
          tips: state.refs.values(),
          serverShallow: state.repositoryShallow,
        });
        state.serverShallow = new Set(update.shallow);
        state.serverUnshallow = new Set(update.unshallow);
        state.packShallow = update.packShallow;
        state.extraWants = update.extraWants;
        // without a deepen request git sends no shallow section (the client reads none)
        return deepening ? "SHALLOW_COMPUTED" : "SHALLOW_REGISTERED";
      } catch (e) {
        output.error = e instanceof UploadPackRequestError ? e.message : String(e);
        return e instanceof UploadPackRequestError ? "INVALID_REQUEST" : "ERROR";
      }
    },
  ],

  // Send shallow/unshallow to client
  [
    "SEND_SHALLOW_UPDATE",
    async (ctx) => {
      const transport = getTransport(ctx);
      const state = getState(ctx);
      const output = getOutput(ctx);

      try {
        for (const oid of state.serverShallow ?? []) {
          await transport.writeLine(`shallow ${oid}`);
        }
        for (const oid of state.serverUnshallow ?? []) {
          await transport.writeLine(`unshallow ${oid}`);
        }
        await transport.writeFlush();
        return "SHALLOW_SENT";
      } catch (e) {
        output.error = String(e);
        return "ERROR";
      }
    },
  ],

  // Read one batch of haves, answering each as git's get_common_commits does while it reads:
  // a have we have is "ACK <oid> common" (multi_ack_detailed), "ACK <oid> continue"
  // (multi_ack) or, for the first one only, "ACK <oid>" (no multi_ack); a have we lack, once
  // every want reaches a common commit (ok_to_give_up), is "ACK <oid> ready" / "continue"
  [
    "READ_HAVES",
    async (ctx) => {
      const transport = getTransport(ctx);
      const state = getState(ctx);
      const output = getOutput(ctx);
      const repository = getRepository(ctx);
      const negotiation = negotiationOf(ctx);

      try {
        const multiAckDetailed = state.capabilities.has("multi_ack_detailed");
        const multiAck = multiAckDetailed || state.capabilities.has("multi_ack");
        let first = true;
        while (true) {
          const pkt = await transport.readPktLine();

          if (pkt.type === "flush") {
            return "FLUSH_RECEIVED";
          }
          if (pkt.type === "eof") {
            // git's upload-pack with --stateless-rpc exits once a batch was answered: a
            // request that ends between batches is complete, not cut short
            if (first && getConfig(ctx).statelessRpc) return "REQUEST_END";
            output.error = "Unexpected end of input";
            return "ERROR";
          }
          first = false;
          if (pkt.type === "delim") {
            continue; // Unexpected delimiter in v1 haves
          }

          // Type narrowing: pkt.type === "data" guaranteed here
          const line = pkt.text.replace(/\n$/, "");

          if (line === "done") {
            return "DONE_RECEIVED";
          }

          if (line.startsWith("have ")) {
            const oid = line.slice(5);
            state.haves.add(oid);
            // a batch with haves is not an empty round
            state.emptyBatchCount = 0;
            negotiation.batchHaves = true;

            if (!(await repository.has(oid))) {
              // git's got_oid() == -1: they have what we do not
              negotiation.gotOther = true;
              if (multiAck && (await okToGiveUp(ctx))) {
                if (multiAckDetailed) {
                  negotiation.sentReady = true;
                  await transport.writeLine(`ACK ${oid} ready`);
                } else {
                  await transport.writeLine(`ACK ${oid} continue`);
                }
              }
              continue;
            }
            negotiation.gotCommon = true;
            state.commonBase.add(oid);
            output.lastAckOid = oid;
            if (multiAckDetailed) await transport.writeLine(`ACK ${oid} common`);
            else if (multiAck) await transport.writeLine(`ACK ${oid} continue`);
            else if (state.commonBase.size === 1) await transport.writeLine(`ACK ${oid}`);
          }
        }
      } catch (e) {
        output.error = String(e);
        return "ERROR";
      }
    },
  ],

  // The end of a batch (a flush), as git's get_common_commits: "ACK <last> ready" when
  // multi_ack_detailed found a common commit and nothing unknown in this batch and may give
  // up; NAK when nothing is common yet or in any multi_ack mode; with no-done after "ready",
  // the final "ACK <last>" and the pack follow at once
  [
    "SEND_ACKS",
    async (ctx) => {
      const transport = getTransport(ctx);
      const config = getConfig(ctx);
      const state = getState(ctx);
      const output = getOutput(ctx);
      const negotiation = negotiationOf(ctx);

      try {
        const multiAckDetailed = state.capabilities.has("multi_ack_detailed");
        const multiAck = multiAckDetailed || state.capabilities.has("multi_ack");
        const last = output.lastAckOid;

        if (
          multiAckDetailed &&
          negotiation.gotCommon &&
          !negotiation.gotOther &&
          last !== undefined &&
          (await okToGiveUp(ctx))
        ) {
          negotiation.sentReady = true;
          await transport.writeLine(`ACK ${last} ready`);
        }
        if (state.commonBase.size === 0 || multiAck) await transport.writeLine("NAK");

        if (state.capabilities.has("no-done") && negotiation.sentReady && last !== undefined) {
          await transport.writeLine(`ACK ${last}`);
          return "SENT_ACK_READY";
        }
        negotiation.gotCommon = false;
        negotiation.gotOther = false;

        // rounds without any have: a client that never sends done (a safeguard, not git's)
        if (!negotiation.batchHaves) {
          state.emptyBatchCount = (state.emptyBatchCount ?? 0) + 1;
          const maxEmpty = config.maxEmptyBatches ?? 10;
          if (state.emptyBatchCount > maxEmpty) {
            output.error = `Too many empty negotiation rounds (${maxEmpty})`;
            return "ERROR";
          }
        }
        negotiation.batchHaves = false;
        return "SENT_NAK";
      } catch (e) {
        output.error = String(e);
        return "ERROR";
      }
    },
  ],

  // "done": the final "ACK <last>" (multi_ack modes) or nothing (single ack: its ACK was
  // sent) when something is common; NAK otherwise (a clone), as git
  [
    "SEND_FINAL_ACK",
    async (ctx) => {
      const transport = getTransport(ctx);
      const state = getState(ctx);
      const output = getOutput(ctx);

      try {
        if (state.commonBase.size > 0) {
          const multiAck =
            state.capabilities.has("multi_ack_detailed") || state.capabilities.has("multi_ack");
          if (multiAck && output.lastAckOid !== undefined) {
            await transport.writeLine(`ACK ${output.lastAckOid}`);
          }
          return "ACK_SENT";
        }
        await transport.writeLine("NAK");
        return "NAK_SENT";
      } catch (e) {
        output.error = String(e);
        return "ERROR";
      }
    },
  ],

  // Send pack: export via SerializationApi, write bytes to transport
  [
    "SEND_PACK",
    async (ctx) => {
      const transport = getTransport(ctx);
      const config = getConfig(ctx);
      const state = getState(ctx);
      const output = getOutput(ctx);
      const repository = getRepository(ctx);

      try {
        const useSideband = state.capabilities.has("side-band-64k");
        const thin = state.capabilities.has("thin-pack");
        const includeTag = state.capabilities.has("include-tag");
        const noProgress = state.capabilities.has("no-progress");

        // Export pack, cut at the shallow boundary (the new shallow commits and the client's
        // own); the parents of unshallowed commits are tips of their own
        const wants = new Set(state.wants);
        for (const oid of state.extraWants ?? []) if (!state.commonBase.has(oid)) wants.add(oid);
        const packStream = repository.exportPack(wants, state.commonBase, {
          thin,
          ofsDelta: state.capabilities.has("ofs-delta"),
          includeTag,
          // git's pack-objects --include-tag: the visible annotated tags of packed objects
          includeTags: includeTag
            ? await includeTagCandidates(config, getRefStore(ctx))
            : undefined,
          filterSpec: state.filterSpec,
          shallow: state.packShallow ?? state.serverShallow,
        });

        // Band 1 with keep-alives until the first byte and errors on band 3; raw otherwise
        const sent = await sendPackStream(transport, packStream, {
          sideband: useSideband,
          progress: !noProgress,
          keepAliveMs: config.keepAliveMs,
        });
        if (sent.ok) {
          output.sentBytes = (output.sentBytes ?? 0) + sent.bytes;
          notifyUpload(config, getRefStore(ctx), repository, uploadRequest(ctx), {
            common: state.commonBase,
            packBytes: sent.bytes,
          });
          return "PACK_SENT";
        }
        output.error = sent.error;
        if (sent.inBand) {
          output.errorReported = true;
          return "SIDEBAND_ERROR";
        }
        // raw pack bytes may be out: the client must see a broken stream, not a short pack
        output.streamBroken = true;
        return "ERROR";
      } catch (e) {
        output.error = String(e);
        return "ERROR";
      }
    },
  ],
]);
