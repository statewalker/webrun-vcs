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
} from "../../context/context-adapters.js";
import { ZERO_OID } from "../../protocol/constants.js";
import type { FsmStateHandler, FsmTransition } from "../types.js";

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
  ["COMPUTE_SHALLOW", "ERROR", ""],

  // Send shallow/unshallow to client
  ["SEND_SHALLOW_UPDATE", "SHALLOW_SENT", "READ_HAVES"],
  ["SEND_SHALLOW_UPDATE", "ERROR", ""],

  // Read filter specification (partial clone)
  ["READ_WANTS", "WANTS_WITH_FILTER", "READ_FILTER"],
  ["READ_FILTER", "FILTER_RECEIVED", "VALIDATE_WANTS"],
  ["READ_FILTER", "ERROR", ""],

  // Read haves from client
  ["READ_HAVES", "HAVES_RECEIVED", "SEND_ACKS"],
  ["READ_HAVES", "DONE_RECEIVED", "SEND_FINAL_ACK"], // client sent done
  ["READ_HAVES", "FLUSH_RECEIVED", "SEND_ACKS"], // End of have batch
  ["READ_HAVES", "ERROR", ""],

  // Send ACK/NAK responses (depends on multi_ack mode)
  // Single-ack mode (no multi_ack capability)
  ["SEND_ACKS", "SENT_SINGLE_ACK", "SEND_PACK"], // Single ACK, go to pack
  ["SEND_ACKS", "SENT_NAK_SINGLE", "READ_HAVES"], // NAK, need more haves

  // multi_ack mode
  ["SEND_ACKS", "SENT_ACK_CONTINUE", "READ_HAVES"], // ACK continue

  // multi_ack_detailed mode
  ["SEND_ACKS", "SENT_NAK", "READ_HAVES"], // NAK, need more haves
  ["SEND_ACKS", "SENT_ACK_COMMON", "READ_HAVES"], // ACK common
  ["SEND_ACKS", "SENT_ACK_READY", "SEND_PACK"], // ACK ready (no-done)
  ["SEND_ACKS", "ERROR", ""],

  // Check if ready to give up (reachability analysis)
  ["SEND_ACKS", "CHECK_REACHABILITY", "CHECK_OK_TO_GIVE_UP"],
  ["CHECK_OK_TO_GIVE_UP", "READY_TO_GIVE_UP", "SEND_ACKS"], // Can send ACK ready
  ["CHECK_OK_TO_GIVE_UP", "NOT_READY", "READ_HAVES"], // Need more haves

  // Send final ACK after done
  ["SEND_FINAL_ACK", "ACK_SENT", "SEND_PACK"],
  ["SEND_FINAL_ACK", "NAK_SENT", "SEND_PACK"], // clone case
  ["SEND_FINAL_ACK", "ERROR", ""],

  // Send pack data
  ["SEND_PACK", "PACK_SENT", ""], // exit
  ["SEND_PACK", "SIDEBAND_ERROR", ""], // Error sent on channel 3
  ["SEND_PACK", "ERROR", ""],
];

/**
 * Check if we can satisfy the fetch request with the current common base.
 * We're "ok to give up" when every wanted commit has at least one ancestor in common base.
 */
async function okToGiveUp(ctx: ProcessContext): Promise<boolean> {
  const state = getState(ctx);
  const repository = getRepository(ctx);

  if (state.commonBase.size === 0) return false;

  // For each want, check if ANY of its ancestors is in the common base
  for (const wantOid of state.wants) {
    let foundCommon = false;

    // Walk ancestors of this want looking for any common base
    for await (const ancestorOid of repository.walkAncestors(wantOid)) {
      if (state.commonBase.has(ancestorOid)) {
        foundCommon = true;
        break;
      }
    }

    if (!foundCommon) {
      return false; // This want has no common ancestor, can't give up yet
    }
  }
  return true;
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
        const refs = await refStore.listAll();
        const capabilities = config.serverCapabilities ?? [
          "multi_ack_detailed",
          "side-band-64k",
          "thin-pack",
          "no-done",
          "ofs-delta",
          "shallow",
          "deepen-since",
          "deepen-not",
          "deepen-relative",
          "no-progress",
          "include-tag",
          "filter",
          "allow-tip-sha1-in-want",
          "allow-reachable-sha1-in-want",
        ];

        let first = true;
        const refsArray = [...refs];

        // Empty repository: send special capabilities^{} line
        if (refsArray.length === 0) {
          await transport.writeLine(`${ZERO_OID} capabilities^{}\0${capabilities.join(" ")}`);
          await transport.writeFlush();
          state.capabilities = new Set(capabilities);
          return "EMPTY_REPO";
        }

        for (const [name, oid] of refsArray) {
          const line = first ? `${oid} ${name}\0${capabilities.join(" ")}` : `${oid} ${name}`;
          await transport.writeLine(line);
          state.refs.set(name, oid);
          first = false;
        }
        await transport.writeFlush();
        state.capabilities = new Set(capabilities);
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
            const parts = line.split(" ");
            const oid = parts[1];
            state.wants.add(oid);
            // Parse capabilities from first want
            if (parts.length > 2) {
              for (const c of parts.slice(2)) {
                state.capabilities.add(c);
              }
            }
          } else if (line.startsWith("shallow ")) {
            hasShallow = true;
            const oid = line.slice(8);
            state.clientShallow = state.clientShallow ?? new Set();
            state.clientShallow.add(oid);
          } else if (
            line.startsWith("deepen ") ||
            line.startsWith("deepen-since ") ||
            line.startsWith("deepen-not ")
          ) {
            hasShallow = true;
            state.deepenRequest = line;
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

        for (const oid of state.wants) {
          let valid = false;

          switch (policy) {
            case "ADVERTISED":
              // Only advertised refs are allowed
              valid = [...state.refs.values()].includes(oid);
              break;
            case "REACHABLE_COMMIT":
              // Reachable from any advertised ref
              if (repository.isReachableFrom) {
                valid = await repository.isReachableFrom(oid, [...state.refs.values()]);
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
              // Reachable from any ref tip
              if (repository.isReachableFromAnyTip) {
                valid = await repository.isReachableFromAnyTip(oid);
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
            output.error = `want ${oid} not valid`;
            output.invalidWant = oid;
            return "INVALID_WANT";
          }
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

  // Compute shallow boundaries
  [
    "COMPUTE_SHALLOW",
    async (ctx) => {
      const state = getState(ctx);
      const output = getOutput(ctx);
      const repository = getRepository(ctx);

      try {
        state.serverShallow = new Set();
        state.serverUnshallow = new Set();

        if (state.deepenRequest) {
          const parts = state.deepenRequest.split(" ");
          const cmd = parts[0];
          const value = parts.slice(1).join(" ");

          if (cmd === "deepen" && repository.computeShallowBoundaries) {
            // Depth-based shallow
            const depth = Number.parseInt(value, 10);
            const boundaries = await repository.computeShallowBoundaries(state.wants, depth);
            state.serverShallow = boundaries;
          } else if (cmd === "deepen-since" && repository.computeShallowSince) {
            // Time-based shallow
            const timestamp = Number.parseInt(value, 10);
            const boundaries = await repository.computeShallowSince(state.wants, timestamp);
            state.serverShallow = boundaries;
          } else if (cmd === "deepen-not" && repository.computeShallowExclude) {
            // Exclude-based shallow
            const boundaries = await repository.computeShallowExclude(
              state.wants,
              [value], // ref name to exclude (as array)
            );
            state.serverShallow = boundaries;
          }
        }

        // Verify client's shallow boundaries
        if (state.clientShallow) {
          for (const oid of state.clientShallow) {
            const exists = await repository.has(oid);
            if (exists && !state.serverShallow?.has(oid)) {
              // Client was shallow here but we can now deepen
              state.serverUnshallow.add(oid);
            }
          }
        }

        return "SHALLOW_COMPUTED";
      } catch (e) {
        output.error = String(e);
        return "ERROR";
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

  // Read haves from client
  [
    "READ_HAVES",
    async (ctx) => {
      const transport = getTransport(ctx);
      const state = getState(ctx);
      const output = getOutput(ctx);
      const repository = getRepository(ctx);

      try {
        while (true) {
          const pkt = await transport.readPktLine();

          if (pkt.type === "flush") {
            return "FLUSH_RECEIVED";
          }
          if (pkt.type === "eof") {
            output.error = "Unexpected end of input";
            return "ERROR";
          }
          if (pkt.type === "delim") {
            continue; // Unexpected delimiter in v1 haves
          }

          // Type narrowing: pkt.type === "data" guaranteed here
          const line = pkt.text;

          if (line === "done") {
            return "DONE_RECEIVED";
          }

          if (line.startsWith("have ")) {
            const oid = line.slice(5);
            state.haves.add(oid);

            // Reset empty batch counter - we received haves
            state.emptyBatchCount = 0;

            // Check if we have this object (to find common ancestors)
            if (await repository.has(oid)) {
              state.commonBase.add(oid);
              output.lastAckOid = oid;
            }
          }
        }
      } catch (e) {
        output.error = String(e);
        return "ERROR";
      }
    },
  ],

  // Send ACK/NAK responses (handles all three multi-ack modes)
  [
    "SEND_ACKS",
    async (ctx) => {
      const transport = getTransport(ctx);
      const config = getConfig(ctx);
      const state = getState(ctx);
      const output = getOutput(ctx);

      try {
        const multiAckDetailed = state.capabilities.has("multi_ack_detailed");
        const multiAck = state.capabilities.has("multi_ack");
        const noDone = state.capabilities.has("no-done");

        // Helper to track empty batches and prevent infinite cycles
        const trackEmptyBatch = (): string | null => {
          state.emptyBatchCount = (state.emptyBatchCount ?? 0) + 1;
          const maxEmpty = config.maxEmptyBatches ?? 10;
          if (state.emptyBatchCount > maxEmpty) {
            output.error = `Too many empty negotiation rounds (${maxEmpty})`;
            return "ERROR";
          }
          return null;
        };

        // Single-ack mode (no multi_ack capability)
        if (!multiAck && !multiAckDetailed) {
          if (state.commonBase.size > 0) {
            await transport.writeLine(`ACK ${[...state.commonBase][0]}`);
            return "SENT_SINGLE_ACK"; // Go directly to pack
          }
          await transport.writeLine("NAK");
          const error = trackEmptyBatch();
          if (error) return error;
          return "SENT_NAK_SINGLE";
        }

        // multi_ack mode (not detailed)
        if (multiAck && !multiAckDetailed) {
          if (state.commonBase.size > 0) {
            for (const oid of state.commonBase) {
              await transport.writeLine(`ACK ${oid} continue`);
            }
            return "SENT_ACK_CONTINUE";
          }
          await transport.writeLine("NAK");
          const error = trackEmptyBatch();
          if (error) return error;
          return "SENT_NAK";
        }

        // multi_ack_detailed mode
        if (state.commonBase.size === 0) {
          await transport.writeLine("NAK");
          const error = trackEmptyBatch();
          if (error) return error;
          return "SENT_NAK";
        }

        // Send ACK common for each common object found in this batch
        const newCommon = [...state.commonBase].filter((oid) => !state.ackedCommon?.has(oid));
        state.ackedCommon = state.ackedCommon ?? new Set();

        for (const oid of newCommon) {
          await transport.writeLine(`ACK ${oid} common`);
          state.ackedCommon.add(oid);
        }

        // Check if ready to send pack (no-done optimization)
        if (noDone) {
          // Check reachability: can we satisfy the request with current common base?
          const ready = await okToGiveUp(ctx);
          if (ready) {
            const ackOid = output.lastAckOid ?? [...state.commonBase][0];
            await transport.writeLine(`ACK ${ackOid} ready`);
            return "SENT_ACK_READY";
          }
        }

        return "SENT_ACK_COMMON";
      } catch (e) {
        output.error = String(e);
        return "ERROR";
      }
    },
  ],

  // Check if OK to give up (reachability analysis for no-done optimization)
  [
    "CHECK_OK_TO_GIVE_UP",
    async (ctx) => {
      const output = getOutput(ctx);

      try {
        const ready = await okToGiveUp(ctx);
        return ready ? "READY_TO_GIVE_UP" : "NOT_READY";
      } catch (e) {
        output.error = String(e);
        return "ERROR";
      }
    },
  ],

  // Send final ACK after done
  [
    "SEND_FINAL_ACK",
    async (ctx) => {
      const transport = getTransport(ctx);
      const state = getState(ctx);
      const output = getOutput(ctx);

      try {
        if (state.commonBase.size > 0) {
          await transport.writeLine(`ACK ${[...state.commonBase][0]}`);
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
      const state = getState(ctx);
      const output = getOutput(ctx);
      const repository = getRepository(ctx);

      try {
        const useSideband = state.capabilities.has("side-band-64k");
        const thin = state.capabilities.has("thin-pack");
        const includeTag = state.capabilities.has("include-tag");
        const noProgress = state.capabilities.has("no-progress");

        // Apply filter if partial clone requested
        const filterSpec = state.filterSpec;

        // Export pack with options
        const packStream = repository.exportPack(state.wants, state.commonBase, {
          thin,
          includeTag,
          filterSpec,
          shallow: state.serverShallow,
        });

        if (useSideband) {
          // Progress callback
          const sendProgress = noProgress
            ? null
            : async (msg: string) => {
                await transport.writeSideband(2, new TextEncoder().encode(msg));
              };

          try {
            for await (const chunk of packStream) {
              await transport.writeSideband(1, chunk);
              if (sendProgress) {
                await sendProgress(`Sending objects: ${output.sentBytes ?? 0}\r`);
              }
              output.sentBytes = (output.sentBytes ?? 0) + chunk.length;
            }
            await transport.writeFlush();
            return "PACK_SENT";
          } catch (packError) {
            // Send error on sideband channel 3
            await transport.writeSideband(3, new TextEncoder().encode(`ERR ${packError}`));
            await transport.writeFlush();
            output.error = String(packError);
            return "SIDEBAND_ERROR";
          }
        } else {
          // No sideband: raw pack bytes
          await transport.writePack(packStream);
          return "PACK_SENT";
        }
      } catch (e) {
        output.error = String(e);
        return "ERROR";
      }
    },
  ],
]);
