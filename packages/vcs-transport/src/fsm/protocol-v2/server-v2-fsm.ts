/**
 * Protocol V2 Server FSM.
 *
 * Handles the server side of Git protocol V2:
 * 1. Send capability advertisement
 * 2. Read and handle commands (ls-refs, fetch, object-info)
 * 3. Send appropriate responses
 */

import type { ProcessContext } from "../../context/process-context.js";
import type { FsmStateHandler, FsmTransition } from "../types.js";
import { createEmptyFetchRequest, type FetchV2Request, SERVER_V2_CAPABILITIES } from "./types.js";

/**
 * Server V2 FSM transitions.
 */
export const serverV2Transitions: FsmTransition[] = [
  // Entry: send capability advertisement
  ["", "START", "SEND_CAPABILITIES"],

  // Send capabilities
  ["SEND_CAPABILITIES", "CAPS_SENT", "READ_COMMAND"],
  ["SEND_CAPABILITIES", "ERROR", ""],

  // Read command from client
  ["READ_COMMAND", "LS_REFS", "HANDLE_LS_REFS"],
  ["READ_COMMAND", "FETCH", "HANDLE_FETCH"],
  ["READ_COMMAND", "OBJECT_INFO", "HANDLE_OBJECT_INFO"],
  ["READ_COMMAND", "FLUSH", ""], // Client done
  ["READ_COMMAND", "ERROR", ""],

  // Handle ls-refs command
  ["HANDLE_LS_REFS", "LS_REFS_DONE", "READ_COMMAND"],
  ["HANDLE_LS_REFS", "ERROR", ""],

  // Handle fetch command
  ["HANDLE_FETCH", "PARSE_FETCH_ARGS", "PARSE_FETCH"],

  // Parse fetch arguments
  ["PARSE_FETCH", "FETCH_PARSED", "VALIDATE_FETCH_WANTS"],
  ["PARSE_FETCH", "ERROR", ""],

  // Validate fetch wants
  ["VALIDATE_FETCH_WANTS", "VALID", "PROCESS_HAVES"],
  ["VALIDATE_FETCH_WANTS", "INVALID_WANT", "SEND_ERROR"],
  ["VALIDATE_FETCH_WANTS", "ERROR", ""],

  // Process haves and compute common base
  ["PROCESS_HAVES", "COMPUTED", "CHECK_READY_TO_SEND"],
  ["PROCESS_HAVES", "ERROR", ""],

  // Check if ready to send pack
  ["CHECK_READY_TO_SEND", "READY", "SEND_FETCH_RESPONSE"],
  ["CHECK_READY_TO_SEND", "NOT_READY", "SEND_ACKS_ONLY"],

  // Send acks-only response (need more haves)
  ["SEND_ACKS_ONLY", "ACKS_SENT", "READ_COMMAND"],
  ["SEND_ACKS_ONLY", "ERROR", ""],

  // Send full fetch response with packfile
  ["SEND_FETCH_RESPONSE", "SEND_ACKS", "SEND_ACKNOWLEDGMENTS"],

  // Send acknowledgments section
  ["SEND_ACKNOWLEDGMENTS", "ACKS_DONE", "SEND_SHALLOW_INFO"],
  ["SEND_ACKNOWLEDGMENTS", "ERROR", ""],

  // Send shallow-info section (if shallow requested)
  ["SEND_SHALLOW_INFO", "SHALLOW_DONE", "SEND_WANTED_REFS"],
  ["SEND_SHALLOW_INFO", "NO_SHALLOW", "SEND_WANTED_REFS"],
  ["SEND_SHALLOW_INFO", "ERROR", ""],

  // Send wanted-refs section (if want-ref used)
  ["SEND_WANTED_REFS", "REFS_DONE", "SEND_PACKFILE"],
  ["SEND_WANTED_REFS", "NO_WANTED_REFS", "SEND_PACKFILE"],
  ["SEND_WANTED_REFS", "ERROR", ""],

  // Send packfile
  ["SEND_PACKFILE", "PACKFILE_SENT", "READ_COMMAND"],
  ["SEND_PACKFILE", "ERROR", ""],

  // Handle object-info command
  ["HANDLE_OBJECT_INFO", "OBJECT_INFO_DONE", "READ_COMMAND"],
  ["HANDLE_OBJECT_INFO", "ERROR", ""],

  // Send error
  ["SEND_ERROR", "ERROR_SENT", ""],
];

/**
 * Server V2 FSM handlers.
 */
export const serverV2Handlers = new Map<string, FsmStateHandler<ProcessContext>>([
  // Initial handler
  ["", async () => "START"],

  // Send capability advertisement
  [
    "SEND_CAPABILITIES",
    async (ctx) => {
      try {
        await ctx.transport.writeLine("version 2");

        const capabilities = ctx.config.serverCapabilities ?? SERVER_V2_CAPABILITIES;
        for (const cap of capabilities) {
          await ctx.transport.writeLine(cap);
        }

        await ctx.transport.writeFlush();
        return "CAPS_SENT";
      } catch (e) {
        ctx.output.error = String(e);
        return "ERROR";
      }
    },
  ],

  // Read command from client
  [
    "READ_COMMAND",
    async (ctx) => {
      try {
        const pkt = await ctx.transport.readPktLine();

        if (pkt.type === "flush" || pkt.type === "eof") {
          return "FLUSH";
        }
        if (pkt.type === "delim") {
          ctx.output.error = "Unexpected delimiter, expected command";
          return "ERROR";
        }

        const line = pkt.text;

        if (line.startsWith("command=ls-refs")) {
          ctx.state.currentCommand = "ls-refs";
          return "LS_REFS";
        }
        if (line.startsWith("command=fetch")) {
          ctx.state.currentCommand = "fetch";
          return "FETCH";
        }
        if (line.startsWith("command=object-info")) {
          ctx.state.currentCommand = "object-info";
          return "OBJECT_INFO";
        }

        ctx.output.error = `Unknown command: ${line}`;
        return "ERROR";
      } catch (e) {
        ctx.output.error = String(e);
        return "ERROR";
      }
    },
  ],

  // Handle ls-refs command
  [
    "HANDLE_LS_REFS",
    async (ctx) => {
      try {
        let symrefs = false;
        let peel = false;
        let unborn = false;
        const refPrefixes: string[] = [];

        // Read arguments until flush
        while (true) {
          const pkt = await ctx.transport.readPktLine();
          if (pkt.type === "flush") break;
          if (pkt.type === "delim") continue;
          if (pkt.type === "eof") {
            ctx.output.error = "Unexpected end of stream in ls-refs args";
            return "ERROR";
          }

          const line = pkt.text;
          if (line === "symrefs") symrefs = true;
          else if (line === "peel") peel = true;
          else if (line === "unborn") unborn = true;
          else if (line.startsWith("ref-prefix ")) {
            refPrefixes.push(line.slice(11));
          }
        }

        // Get refs
        const allRefs = Array.from(await ctx.refStore.listAll());

        // Filter by prefixes
        const matchingRefs =
          refPrefixes.length > 0
            ? allRefs.filter(([name]) => refPrefixes.some((p) => name.startsWith(p)))
            : allRefs;

        // Send refs
        for (const [name, oid] of matchingRefs) {
          let line = `${oid} ${name}`;

          if (symrefs && ctx.refStore.getSymrefTarget) {
            const target = await ctx.refStore.getSymrefTarget(name);
            if (target) {
              line += ` symref-target:${target}`;
            }
          }
          if (peel && ctx.repository.peelTag) {
            const peeled = await ctx.repository.peelTag(oid);
            if (peeled && peeled !== oid) {
              line += ` peeled:${peeled}`;
            }
          }

          await ctx.transport.writeLine(line);
        }

        // Handle unborn HEAD
        if (unborn && matchingRefs.length === 0 && ctx.refStore.getSymrefTarget) {
          const headTarget = await ctx.refStore.getSymrefTarget("HEAD");
          if (headTarget) {
            await ctx.transport.writeLine(`unborn HEAD symref-target:${headTarget}`);
          }
        }

        await ctx.transport.writeFlush();
        return "LS_REFS_DONE";
      } catch (e) {
        ctx.output.error = String(e);
        return "ERROR";
      }
    },
  ],

  // Handle fetch command - initialize request
  [
    "HANDLE_FETCH",
    async (ctx) => {
      try {
        (ctx.state as ServerV2State).fetchRequest = createEmptyFetchRequest();
        return "PARSE_FETCH_ARGS";
      } catch (e) {
        ctx.output.error = String(e);
        return "ERROR";
      }
    },
  ],

  // Parse fetch arguments
  [
    "PARSE_FETCH",
    async (ctx) => {
      try {
        const state = ctx.state as ServerV2State;
        const req = state.fetchRequest;
        if (!req) {
          ctx.output.error = "Internal error: fetchRequest not initialized";
          return "ERROR";
        }

        while (true) {
          const pkt = await ctx.transport.readPktLine();
          if (pkt.type === "flush") break;
          if (pkt.type === "delim") continue;
          if (pkt.type === "eof") {
            ctx.output.error = "Unexpected end of stream in fetch args";
            return "ERROR";
          }

          const line = pkt.text;

          if (line.startsWith("want ")) {
            req.wants.push(line.slice(5));
          } else if (line.startsWith("want-ref ")) {
            req.wantRefs.push(line.slice(9));
          } else if (line.startsWith("have ")) {
            req.haves.push(line.slice(5));
          } else if (line === "done") {
            req.done = true;
          } else if (line.startsWith("shallow ")) {
            req.shallow.push(line.slice(8));
          } else if (line.startsWith("deepen ")) {
            req.deepen = parseInt(line.slice(7), 10);
          } else if (line.startsWith("deepen-since ")) {
            req.deepenSince = parseInt(line.slice(13), 10);
          } else if (line.startsWith("deepen-not ")) {
            req.deepenNot = req.deepenNot ?? [];
            req.deepenNot.push(line.slice(11));
          } else if (line === "deepen-relative") {
            req.deepenRelative = true;
          } else if (line.startsWith("filter ")) {
            req.filter = line.slice(7);
          } else if (line === "thin-pack") {
            req.thinPack = true;
          } else if (line === "no-progress") {
            req.noProgress = true;
          } else if (line === "include-tag") {
            req.includeTags = true;
          } else if (line === "ofs-delta") {
            req.ofsDeltas = true;
          }
        }

        return "FETCH_PARSED";
      } catch (e) {
        ctx.output.error = String(e);
        return "ERROR";
      }
    },
  ],

  // Validate fetch wants
  [
    "VALIDATE_FETCH_WANTS",
    async (ctx) => {
      try {
        const state = ctx.state as ServerV2State;
        const req = state.fetchRequest;
        if (!req) {
          ctx.output.error = "Internal error: fetchRequest not initialized";
          return "ERROR";
        }

        ctx.state.wants = new Set();

        // Resolve want-refs to OIDs
        for (const refName of req.wantRefs) {
          const oid = await ctx.refStore.get(refName);
          if (!oid) {
            ctx.output.error = `Unknown ref: ${refName}`;
            ctx.output.invalidWant = refName;
            return "INVALID_WANT";
          }
          ctx.state.wants.add(oid);
          ctx.state.wantedRefs = ctx.state.wantedRefs ?? new Map();
          ctx.state.wantedRefs.set(refName, oid);
        }

        // Add direct wants
        for (const oid of req.wants) {
          const valid = await ctx.repository.has(oid);
          if (!valid) {
            ctx.output.error = `Object not found: ${oid}`;
            ctx.output.invalidWant = oid;
            return "INVALID_WANT";
          }
          ctx.state.wants.add(oid);
        }

        return "VALID";
      } catch (e) {
        ctx.output.error = String(e);
        return "ERROR";
      }
    },
  ],

  // Process haves
  [
    "PROCESS_HAVES",
    async (ctx) => {
      try {
        const state = ctx.state as ServerV2State;
        const req = state.fetchRequest;
        if (!req) {
          ctx.output.error = "Internal error: fetchRequest not initialized";
          return "ERROR";
        }

        ctx.state.commonBase = new Set();
        ctx.state.acks = [];

        for (const oid of req.haves) {
          if (await ctx.repository.has(oid)) {
            ctx.state.commonBase.add(oid);
            ctx.state.acks = ctx.state.acks ?? [];
            ctx.state.acks.push(oid);
          }
        }

        return "COMPUTED";
      } catch (e) {
        ctx.output.error = String(e);
        return "ERROR";
      }
    },
  ],

  // Check if ready to send pack
  [
    "CHECK_READY_TO_SEND",
    async (ctx) => {
      try {
        const state = ctx.state as ServerV2State;
        const req = state.fetchRequest;
        if (!req) {
          ctx.output.error = "Internal error: fetchRequest not initialized";
          return "ERROR";
        }

        // If client sent "done", we must send pack
        if (req.done) {
          return "READY";
        }

        // Without "done", only send pack if we have a good common base
        // For simplicity, always return READY if we have any common objects
        const hasCommon = ctx.state.commonBase && ctx.state.commonBase.size > 0;
        return hasCommon || req.haves.length === 0 ? "READY" : "NOT_READY";
      } catch (e) {
        ctx.output.error = String(e);
        return "ERROR";
      }
    },
  ],

  // Send acks-only response
  [
    "SEND_ACKS_ONLY",
    async (ctx) => {
      try {
        await ctx.transport.writeLine("acknowledgments");

        for (const oid of ctx.state.acks ?? []) {
          await ctx.transport.writeLine(`ACK ${oid}`);
        }

        await ctx.transport.writeFlush();
        return "ACKS_SENT";
      } catch (e) {
        ctx.output.error = String(e);
        return "ERROR";
      }
    },
  ],

  // Start sending full fetch response
  [
    "SEND_FETCH_RESPONSE",
    async () => {
      return "SEND_ACKS";
    },
  ],

  // Send acknowledgments section
  [
    "SEND_ACKNOWLEDGMENTS",
    async (ctx) => {
      try {
        await ctx.transport.writeLine("acknowledgments");

        for (const oid of ctx.state.acks ?? []) {
          await ctx.transport.writeLine(`ACK ${oid}`);
        }

        await ctx.transport.writeLine("ready");
        await ctx.transport.writeDelimiter();
        return "ACKS_DONE";
      } catch (e) {
        ctx.output.error = String(e);
        return "ERROR";
      }
    },
  ],

  // Send shallow-info section
  [
    "SEND_SHALLOW_INFO",
    async (ctx) => {
      try {
        const state = ctx.state as ServerV2State;
        const req = state.fetchRequest;

        // Check if shallow info is needed
        if (!req || (req.deepen === 0 && !req.deepenSince && !req.deepenNot?.length)) {
          return "NO_SHALLOW";
        }

        await ctx.transport.writeLine("shallow-info");

        if (ctx.state.serverShallow) {
          for (const oid of ctx.state.serverShallow) {
            await ctx.transport.writeLine(`shallow ${oid}`);
          }
        }

        if (ctx.state.serverUnshallow) {
          for (const oid of ctx.state.serverUnshallow) {
            await ctx.transport.writeLine(`unshallow ${oid}`);
          }
        }

        await ctx.transport.writeDelimiter();
        return "SHALLOW_DONE";
      } catch (e) {
        ctx.output.error = String(e);
        return "ERROR";
      }
    },
  ],

  // Send wanted-refs section
  [
    "SEND_WANTED_REFS",
    async (ctx) => {
      try {
        const state = ctx.state as ServerV2State;
        const req = state.fetchRequest;

        if (!req || req.wantRefs.length === 0) {
          return "NO_WANTED_REFS";
        }

        await ctx.transport.writeLine("wanted-refs");

        for (const [refName, oid] of ctx.state.wantedRefs ?? new Map()) {
          await ctx.transport.writeLine(`${oid} ${refName}`);
        }

        await ctx.transport.writeDelimiter();
        return "REFS_DONE";
      } catch (e) {
        ctx.output.error = String(e);
        return "ERROR";
      }
    },
  ],

  // Send packfile
  [
    "SEND_PACKFILE",
    async (ctx) => {
      try {
        const state = ctx.state as ServerV2State;
        const req = state.fetchRequest;

        await ctx.transport.writeLine("packfile");

        // Export pack
        const thin = req?.thinPack ?? false;
        const packStream = ctx.repository.exportPack(
          ctx.state.wants,
          ctx.state.commonBase ?? new Set(),
          {
            thin,
            includeTag: req?.includeTags,
            filterSpec: req?.filter ?? undefined,
          },
        );

        await ctx.transport.writePack(packStream);
        return "PACKFILE_SENT";
      } catch (e) {
        ctx.output.error = String(e);
        return "ERROR";
      }
    },
  ],

  // Handle object-info command
  [
    "HANDLE_OBJECT_INFO",
    async (ctx) => {
      try {
        const objectIds: string[] = [];

        // Read arguments until flush
        while (true) {
          const pkt = await ctx.transport.readPktLine();
          if (pkt.type === "flush") break;
          if (pkt.type === "delim") continue;
          if (pkt.type === "eof") {
            ctx.output.error = "Unexpected end of stream in object-info args";
            return "ERROR";
          }

          const line = pkt.text;
          if (line.startsWith("oid ")) {
            objectIds.push(line.slice(4));
          }
        }

        // Send size info for requested objects
        await ctx.transport.writeLine("size");

        for (const oid of objectIds) {
          if (ctx.repository.getObjectSize) {
            const size = await ctx.repository.getObjectSize(oid);
            if (size !== null) {
              await ctx.transport.writeLine(`${oid} ${size}`);
            }
          }
        }

        await ctx.transport.writeFlush();
        return "OBJECT_INFO_DONE";
      } catch (e) {
        ctx.output.error = String(e);
        return "ERROR";
      }
    },
  ],

  // Send error
  [
    "SEND_ERROR",
    async (ctx) => {
      try {
        const errorMsg = ctx.output.error ?? "Unknown error";
        await ctx.transport.writeLine(`ERR ${errorMsg}`);
        await ctx.transport.writeFlush();
        return "ERROR_SENT";
      } catch (e) {
        ctx.output.error = String(e);
        return "ERROR";
      }
    },
  ],
]);

/**
 * Extended context state for V2 server operations.
 */
interface ServerV2State {
  fetchRequest?: FetchV2Request;
}
