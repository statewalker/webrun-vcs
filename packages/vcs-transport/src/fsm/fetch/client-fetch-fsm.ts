/**
 * Client Fetch FSM - handles Git fetch operations from the client perspective.
 *
 * Protocol flow:
 * 1. Read refs from server advertisement
 * 2. Send wants (objects we need)
 * 3. Send shallow info (if shallow clone)
 * 4. Negotiate with haves/acks
 * 5. Receive pack
 * 6. Update local refs
 */

import {
  getConfig,
  getOutput,
  getRefStore,
  getRepository,
  getState,
  getTransport,
  type ProcessContext,
} from "../../context/context-adapters.js";
import {
  applyAdvertisementToState,
  parseAdvertisement,
} from "../../protocol/advertisement-parser.js";
import type { FsmStateHandler, FsmTransition } from "../types.js";

/**
 * Client fetch FSM transitions.
 */
export const clientFetchTransitions: FsmTransition[] = [
  // Entry point: "" is the initial state
  ["", "START", "READ_ADVERTISEMENT"],

  // Read refs from server
  ["READ_ADVERTISEMENT", "REFS_RECEIVED", "SEND_WANTS"],
  ["READ_ADVERTISEMENT", "EMPTY_REPO", ""], // Server has no refs
  ["READ_ADVERTISEMENT", "ERROR", ""],

  // Send wants to server
  ["SEND_WANTS", "WANTS_SENT", "SEND_SHALLOW_INFO"],
  ["SEND_WANTS", "WANTS_SENT_NO_SHALLOW", "SEND_HAVES"], // No shallow needed
  ["SEND_WANTS", "NO_WANTS", ""], // nothing to fetch, exit
  ["SEND_WANTS", "ERROR", ""],

  // Shallow fetch: send depth/since/not info
  ["SEND_SHALLOW_INFO", "SHALLOW_SENT", "SEND_HAVES"],
  ["SEND_SHALLOW_INFO", "DEEPEN_SENT", "READ_SHALLOW_UPDATE"],
  ["SEND_SHALLOW_INFO", "ERROR", ""],

  // Read shallow update from server
  ["READ_SHALLOW_UPDATE", "SHALLOW_UPDATED", "SEND_HAVES"],
  ["READ_SHALLOW_UPDATE", "ERROR", ""],

  // Partial clone: send filter specification
  ["SEND_WANTS", "WANTS_SENT_FILTER", "SEND_FILTER"],
  ["SEND_FILTER", "FILTER_SENT", "SEND_SHALLOW_INFO"],
  ["SEND_FILTER", "ERROR", ""],

  // Negotiation: send haves
  ["SEND_HAVES", "HAVES_SENT", "READ_ACKS"],
  ["SEND_HAVES", "NO_HAVES", "SEND_DONE"], // no local commits
  ["SEND_HAVES", "ALL_HAVES_SENT", "SEND_DONE"], // Stateless RPC: all haves at once
  ["SEND_HAVES", "MAX_HAVES", "SEND_DONE"], // hit max haves limit
  ["SEND_HAVES", "ERROR", ""],

  // Negotiation: read ACK/NAK responses
  ["READ_ACKS", "NAK", "SEND_HAVES"], // continue sending
  ["READ_ACKS", "ACK_CONTINUE", "SEND_HAVES"], // common found, continue
  ["READ_ACKS", "ACK_COMMON", "SEND_HAVES"], // multi_ack_detailed: common base found
  ["READ_ACKS", "ACK_READY", "RECEIVE_PACK"], // server ready (no-done)
  ["READ_ACKS", "ACK_SINGLE", "RECEIVE_PACK"], // single-ack mode: go directly to pack
  ["READ_ACKS", "MAX_HAVES", "SEND_DONE"], // sent enough
  ["READ_ACKS", "ERROR", ""],

  // Send done
  ["SEND_DONE", "DONE_SENT", "READ_FINAL_ACK"],
  ["SEND_DONE", "DONE_SENT_STATELESS", "RECEIVE_PACK"], // Stateless RPC: no final ack
  ["SEND_DONE", "ERROR", ""],

  // Read final ACK/NAK after done
  ["READ_FINAL_ACK", "ACK_FINAL", "RECEIVE_PACK"],
  ["READ_FINAL_ACK", "NAK_FINAL", "RECEIVE_PACK"], // clone case
  ["READ_FINAL_ACK", "ERROR", ""],

  // Receive pack data
  ["RECEIVE_PACK", "PACK_RECEIVED", "UPDATE_REFS"],
  ["RECEIVE_PACK", "SIDEBAND_ERROR", ""], // Error on channel 3
  ["RECEIVE_PACK", "ERROR", ""],

  // Update local refs after successful pack import
  ["UPDATE_REFS", "REFS_UPDATED", ""], // exit
  ["UPDATE_REFS", "ERROR", ""],
];

/**
 * Client fetch FSM handlers.
 */
export const clientFetchHandlers = new Map<string, FsmStateHandler<ProcessContext>>([
  // Initial handler - triggers START event
  ["", async () => "START"],

  // Read advertisement from server
  [
    "READ_ADVERTISEMENT",
    async (ctx) => {
      const transport = getTransport(ctx);
      const state = getState(ctx);
      const output = getOutput(ctx);

      try {
        const result = await parseAdvertisement(() => transport.readPktLine());
        applyAdvertisementToState(result, state);

        return result.isEmpty ? "EMPTY_REPO" : "REFS_RECEIVED";
      } catch (e) {
        output.error = String(e);
        return "ERROR";
      }
    },
  ],

  // Send wants
  [
    "SEND_WANTS",
    async (ctx) => {
      const transport = getTransport(ctx);
      const config = getConfig(ctx);
      const state = getState(ctx);
      const output = getOutput(ctx);
      const repository = getRepository(ctx);

      try {
        // Determine what we want (objects we don't have locally)
        for (const [, oid] of state.refs) {
          if (!(await repository.has(oid))) {
            state.wants.add(oid);
          }
        }

        if (state.wants.size === 0) {
          // Send flush to tell the server we have no wants.
          // Without this, the server's READ_WANTS handler blocks forever
          // waiting for pkt-line data that never arrives.
          await transport.writeFlush();
          return "NO_WANTS";
        }

        // Build capability string
        const supportedCaps = [
          "multi_ack_detailed",
          "side-band-64k",
          "thin-pack",
          "no-done",
          "ofs-delta",
          "shallow",
          "deepen-since",
          "deepen-not",
          "filter",
          "include-tag",
          "no-progress",
        ];
        const clientCaps = [...state.capabilities].filter((c) => supportedCaps.includes(c));

        let first = true;
        for (const oid of state.wants) {
          const line = first ? `want ${oid} ${clientCaps.join(" ")}` : `want ${oid}`;
          await transport.writeLine(line);
          first = false;
        }
        await transport.writeFlush();

        // Determine next state based on configuration
        if (config.filter) {
          return "WANTS_SENT_FILTER";
        }
        if (config.depth || config.shallowSince || config.shallowExclude?.length) {
          return "WANTS_SENT"; // Goes to SEND_SHALLOW_INFO
        }
        return "WANTS_SENT_NO_SHALLOW"; // Skip shallow, go directly to haves
      } catch (e) {
        output.error = String(e);
        return "ERROR";
      }
    },
  ],

  // Send filter specification (partial clone)
  [
    "SEND_FILTER",
    async (ctx) => {
      const transport = getTransport(ctx);
      const config = getConfig(ctx);
      const output = getOutput(ctx);

      try {
        if (config.filter) {
          await transport.writeLine(`filter ${config.filter}`);
        }
        await transport.writeFlush();
        return "FILTER_SENT";
      } catch (e) {
        output.error = String(e);
        return "ERROR";
      }
    },
  ],

  // Send shallow information
  [
    "SEND_SHALLOW_INFO",
    async (ctx) => {
      const transport = getTransport(ctx);
      const config = getConfig(ctx);
      const state = getState(ctx);
      const output = getOutput(ctx);

      try {
        // Send existing shallow boundaries
        for (const oid of state.clientShallow ?? []) {
          await transport.writeLine(`shallow ${oid}`);
        }

        // Send deepen request
        if (config.depth) {
          await transport.writeLine(`deepen ${config.depth}`);
          await transport.writeFlush();
          return "DEEPEN_SENT";
        }
        if (config.shallowSince) {
          await transport.writeLine(`deepen-since ${config.shallowSince}`);
          await transport.writeFlush();
          return "DEEPEN_SENT";
        }
        if (config.shallowExclude) {
          for (const ref of config.shallowExclude) {
            await transport.writeLine(`deepen-not ${ref}`);
          }
          await transport.writeFlush();
          return "DEEPEN_SENT";
        }

        await transport.writeFlush();
        return "SHALLOW_SENT";
      } catch (e) {
        output.error = String(e);
        return "ERROR";
      }
    },
  ],

  // Read shallow update from server
  [
    "READ_SHALLOW_UPDATE",
    async (ctx) => {
      const transport = getTransport(ctx);
      const state = getState(ctx);
      const output = getOutput(ctx);

      try {
        state.serverShallow = state.serverShallow ?? new Set();
        state.serverUnshallow = state.serverUnshallow ?? new Set();

        while (true) {
          const pkt = await transport.readPktLine();
          if (pkt.type === "flush") break;
          if (pkt.type === "eof") {
            output.error = "Unexpected end of input during shallow update";
            return "ERROR";
          }
          if (pkt.type === "delim") {
            continue; // Unexpected delimiter in shallow update
          }

          const line = pkt.text;
          if (line.startsWith("shallow ")) {
            state.serverShallow.add(line.slice(8));
          } else if (line.startsWith("unshallow ")) {
            state.serverUnshallow.add(line.slice(10));
          }
        }
        return "SHALLOW_UPDATED";
      } catch (e) {
        output.error = String(e);
        return "ERROR";
      }
    },
  ],

  // Send haves
  [
    "SEND_HAVES",
    async (ctx) => {
      const transport = getTransport(ctx);
      const config = getConfig(ctx);
      const state = getState(ctx);
      const output = getOutput(ctx);
      const repository = getRepository(ctx);

      try {
        const BATCH_SIZE = 32;
        let sentInBatch = 0;
        output.havesSent = output.havesSent ?? 0;
        output.havesSinceLastContinue = output.havesSinceLastContinue ?? 0;

        const maxHaves = config.maxHaves ?? 256;

        // Stateless RPC mode (HTTP): send all haves at once
        if (config.statelessRpc) {
          if (config.localHead) {
            for await (const oid of repository.walkAncestors(config.localHead)) {
              if (state.commonBase.has(oid)) continue;
              await transport.writeLine(`have ${oid}`);
              state.haves.add(oid);
              output.havesSent++;
              output.havesSinceLastContinue++;
            }
          }
          await transport.writeFlush();
          return output.havesSent > 0 ? "ALL_HAVES_SENT" : "NO_HAVES";
        }

        // Walk local commit ancestry (streaming mode)
        if (config.localHead) {
          for await (const oid of repository.walkAncestors(config.localHead)) {
            if (
              output.havesSent >= maxHaves ||
              (output.receivedContinue && output.havesSinceLastContinue >= maxHaves)
            ) {
              await transport.writeFlush();
              return "MAX_HAVES";
            }

            if (state.commonBase.has(oid)) continue;

            await transport.writeLine(`have ${oid}`);
            state.haves.add(oid);
            output.havesSent++;
            output.havesSinceLastContinue++;
            sentInBatch++;

            if (sentInBatch >= BATCH_SIZE) {
              await transport.writeFlush();

              // JGit "race ahead" optimization: on first block (32 haves),
              // continue sending without waiting for ACKs to reduce latency.
              if (output.havesSent === BATCH_SIZE) {
                sentInBatch = 0;
                continue; // Send another batch before reading ACKs
              }

              return "HAVES_SENT";
            }
          }
        }

        if (sentInBatch > 0) {
          await transport.writeFlush();
          return "HAVES_SENT";
        }
        return "NO_HAVES";
      } catch (e) {
        output.error = String(e);
        return "ERROR";
      }
    },
  ],

  // Read ACK/NAK responses
  [
    "READ_ACKS",
    async (ctx) => {
      const transport = getTransport(ctx);
      const state = getState(ctx);
      const output = getOutput(ctx);

      try {
        const multiAckDetailed = state.capabilities.has("multi_ack_detailed");
        const multiAck = state.capabilities.has("multi_ack");

        while (true) {
          const pkt = await transport.readPktLine();

          if (pkt.type === "flush") return "NAK";
          if (pkt.type === "eof") {
            output.error = "Unexpected end of input";
            return "ERROR";
          }
          if (pkt.type === "delim") continue;

          const line = pkt.text;

          if (line === "NAK") return "NAK";

          // Single ACK mode
          if (!multiAck && !multiAckDetailed) {
            if (line.startsWith("ACK ")) {
              const oid = line.split(" ")[1];
              state.commonBase.add(oid);
              output.lastAckOid = oid;
              return "ACK_SINGLE";
            }
            output.error = `Unexpected response in single-ack mode: ${line}`;
            return "ERROR";
          }

          // Multi-ack modes
          if (line.startsWith("ACK ")) {
            const parts = line.split(" ");
            const oid = parts[1];
            const mode = parts[2]?.trim();
            state.commonBase.add(oid);
            output.lastAckOid = oid;

            if (multiAckDetailed) {
              if (mode === "ready") {
                output.receivedReady = true;
                output.receivedContinue = true;
                return "ACK_READY";
              }
              if (mode === "common") return "ACK_COMMON";
              if (mode === "continue") {
                output.receivedContinue = true;
                output.havesSinceLastContinue = 0;
                return "ACK_CONTINUE";
              }
            }

            if (multiAck) {
              if (mode === "continue") {
                output.receivedContinue = true;
                output.havesSinceLastContinue = 0;
                return "ACK_CONTINUE";
              }
              return "ACK_FINAL";
            }

            return "ACK_FINAL";
          }
        }
      } catch (e) {
        output.error = String(e);
        return "ERROR";
      }
    },
  ],

  // Send done
  [
    "SEND_DONE",
    async (ctx) => {
      const transport = getTransport(ctx);
      const config = getConfig(ctx);
      const output = getOutput(ctx);

      try {
        await transport.writeLine("done");
        return config.statelessRpc ? "DONE_SENT_STATELESS" : "DONE_SENT";
      } catch (e) {
        output.error = String(e);
        return "ERROR";
      }
    },
  ],

  // Read final ACK/NAK
  [
    "READ_FINAL_ACK",
    async (ctx) => {
      const transport = getTransport(ctx);
      const output = getOutput(ctx);

      try {
        const maxIterations = 100;
        let iterations = 0;

        while (iterations++ < maxIterations) {
          const pkt = await transport.readPktLine();

          if (pkt.type === "eof") {
            output.error = "Expected final ACK/NAK";
            return "ERROR";
          }
          if (pkt.type === "flush") return "NAK_FINAL";

          if (pkt.type === "data") {
            const line = pkt.text;
            if (line === "NAK") return "NAK_FINAL";
            if (line.startsWith("ACK ")) {
              output.lastAckOid = line.split(" ")[1];
              return "ACK_FINAL";
            }
          }
        }

        output.error = "Too many packets waiting for final ACK/NAK";
        return "ERROR";
      } catch (e) {
        output.error = String(e);
        return "ERROR";
      }
    },
  ],

  // Receive pack: read bytes from transport, import via SerializationApi
  [
    "RECEIVE_PACK",
    async (ctx) => {
      const transport = getTransport(ctx);
      const state = getState(ctx);
      const config = getConfig(ctx);
      const output = getOutput(ctx);
      const repository = getRepository(ctx);

      try {
        // Handle sideband multiplexing
        if (state.capabilities.has("side-band-64k")) {
          const packChunks: Uint8Array[] = [];

          // Read pkt-lines and demux sideband channels until flush/eof.
          // Uses readPktLine() directly because readSideband() throws on
          // flush packets which are the normal termination signal.
          while (true) {
            const pkt = await transport.readPktLine();
            if (pkt.type === "flush" || pkt.type === "eof") break;
            if (pkt.type !== "data" || pkt.payload.length < 1) continue;

            const channel = pkt.payload[0];
            const data = pkt.payload.slice(1);

            if (channel === 1) {
              // Pack data channel
              packChunks.push(data);
            } else if (channel === 2) {
              // Progress message channel
              if (!config.noProgress) {
                output.progress = new TextDecoder().decode(data);
              }
            } else if (channel === 3) {
              // Error message from server
              output.error = new TextDecoder().decode(data);
              return "SIDEBAND_ERROR";
            }
          }

          // Import collected pack data
          const packIterable = (async function* () {
            for (const chunk of packChunks) yield chunk;
          })();
          const importResult = await repository.importPack(packIterable);
          output.objectCount = importResult.objectsImported;
        } else {
          // Raw pack data (no sideband)
          const importResult = await repository.importPack(transport.readPack());
          output.objectCount = importResult.objectsImported;
        }

        return "PACK_RECEIVED";
      } catch (e) {
        output.error = String(e);
        return "ERROR";
      }
    },
  ],

  // Update local refs after successful pack import
  [
    "UPDATE_REFS",
    async (ctx) => {
      const state = getState(ctx);
      const config = getConfig(ctx);
      const output = getOutput(ctx);
      const refStore = getRefStore(ctx);

      try {
        if (config.wantedRefs) {
          for (const [ref, oid] of config.wantedRefs) {
            await refStore.update(ref, oid);
          }
        }

        // Handle include-tag: update tag refs if server sent additional tags
        if (state.capabilities.has("include-tag") && output.additionalTags) {
          for (const [tagRef, tagOid] of output.additionalTags) {
            await refStore.update(tagRef, tagOid);
          }
        }

        return "REFS_UPDATED";
      } catch (e) {
        output.error = String(e);
        return "ERROR";
      }
    },
  ],
]);
