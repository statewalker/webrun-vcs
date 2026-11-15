/**
 * Protocol V2 Server FSM.
 *
 * Handles the server side of Git protocol V2:
 * 1. Send capability advertisement
 * 2. Read and handle commands (ls-refs, fetch, object-info)
 * 3. Send appropriate responses
 */

import type { ProcessContext } from "../../context/process-context.js";
import {
  computeShallowUpdate,
  findUnreachableWant,
  notOurRef,
  okToGiveUp,
  type ShallowUpdate,
  sendPackStream,
  UploadPackRequestError,
} from "../fetch/index.js";
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
  ["PARSE_FETCH", "INVALID_REQUEST", "SEND_ERROR"],
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

  // After "done", or without haves, the response has no acknowledgments section (git)
  ["SEND_FETCH_RESPONSE", "NO_ACKS", "SEND_SHALLOW_INFO"],

  // Send acknowledgments section
  ["SEND_ACKNOWLEDGMENTS", "ACKS_DONE", "SEND_SHALLOW_INFO"],
  ["SEND_ACKNOWLEDGMENTS", "ERROR", ""],

  // Send shallow-info section (if shallow requested)
  ["SEND_SHALLOW_INFO", "SHALLOW_DONE", "SEND_WANTED_REFS"],
  ["SEND_SHALLOW_INFO", "NO_SHALLOW", "SEND_WANTED_REFS"],
  ["SEND_SHALLOW_INFO", "INVALID_REQUEST", "SEND_ERROR"],
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
        const state = ctx.state as ServerV2State;
        state.fetchRequest = createEmptyFetchRequest();
        state.sendAcks = undefined;
        state.shallowUpdate = undefined;
        ctx.state.serverShallow = undefined;
        ctx.state.serverUnshallow = undefined;
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
          } else if (line === "wait-for-done") {
            req.waitForDone = true;
          } else if (line.startsWith("shallow ")) {
            req.shallow.push(line.slice(8));
          } else if (line.startsWith("deepen ")) {
            const depth = Number(line.slice(7));
            if (!Number.isInteger(depth) || depth <= 0) {
              ctx.output.error = `Invalid deepen: ${line}`;
              return "INVALID_REQUEST";
            }
            req.deepen = depth;
          } else if (line.startsWith("deepen-since ")) {
            // git refuses 0 (and its -1): no positive time is no cutoff
            const since = Number(line.slice(13));
            if (!Number.isInteger(since) || since <= 0) {
              ctx.output.error = `Invalid deepen-since: ${line}`;
              return "INVALID_REQUEST";
            }
            req.deepenSince = since;
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
        ctx.state.wantedRefs = new Map();

        // Resolve want-refs to OIDs
        for (const refName of req.wantRefs) {
          const oid = await ctx.refStore.get(refName);
          if (!oid) {
            ctx.output.error = `Unknown ref: ${refName}`;
            ctx.output.invalidWant = refName;
            return "INVALID_WANT";
          }
          ctx.state.wants.add(oid);
          ctx.state.wantedRefs.set(refName, oid);
        }

        // A filter is refused unless advertised (the built-in facades do not filter); an
        // advertised one goes to exportPack as `filterSpec`
        if (req.filter !== null && !advertisesFetchFeature(ctx, "filter")) {
          ctx.output.error = `unexpected line: 'filter ${req.filter}'`;
          return "INVALID_WANT";
        }

        // Direct wants: by default git's allowReachableSHA1InWant (the tips, or commits
        // reachable from them); "not our ref" for anything else
        const policy = ctx.config.requestPolicy ?? "REACHABLE_COMMIT";
        const tips = [...(await ctx.refStore.listAll())].map(([, oid]) => oid);
        let refused: string | undefined;
        if (policy === "ANY") {
          for (const oid of req.wants) {
            if (!(await ctx.repository.has(oid))) {
              refused = oid;
              break;
            }
          }
        } else if (policy === "ADVERTISED" || policy === "TIP") {
          const tipSet = new Set(tips);
          refused = req.wants.find((oid) => !tipSet.has(oid));
        } else {
          refused = await findUnreachableWant(ctx.repository, req.wants, tips);
        }
        if (refused !== undefined) {
          ctx.output.error = notOurRef(refused);
          ctx.output.invalidWant = refused;
          return "INVALID_WANT";
        }
        for (const oid of req.wants) ctx.state.wants.add(oid);

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

        // git's FETCH_SEND_ACKS: after "done", or without haves, the pack follows at once
        // (and no acknowledgments section); otherwise "ready" only once every want reaches a
        // common commit (ok_to_give_up), and never with "wait-for-done"
        state.sendAcks = false;
        if (req.done || req.haves.length === 0) return "READY";
        if (req.waitForDone) return "NOT_READY";
        const ready = await okToGiveUp(ctx.repository, ctx.state.wants, ctx.state.commonBase);
        if (!ready) return "NOT_READY";
        state.sendAcks = true;
        return "READY";
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

        const acks = ctx.state.acks ?? [];
        if (acks.length === 0) await ctx.transport.writeLine("NAK");
        for (const oid of acks) {
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
    async (ctx) => {
      return (ctx.state as ServerV2State).sendAcks === false ? "NO_ACKS" : "SEND_ACKS";
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

        // git's send_shallow_info: only for a deepen request, or a client that is shallow
        if (
          !req ||
          (req.deepen === 0 &&
            req.deepenSince === undefined &&
            !req.deepenNot?.length &&
            req.shallow.length === 0)
        ) {
          return "NO_SHALLOW";
        }

        let update: ShallowUpdate;
        try {
          const deepenNot: string[] = [];
          for (const name of req.deepenNot ?? []) {
            const oid = await resolveDeepenNot(ctx.refStore, name);
            if (!oid) {
              throw new UploadPackRequestError(
                `git upload-pack: ambiguous deepen-not: deepen-not ${name}`,
              );
            }
            deepenNot.push(oid);
          }
          update = await computeShallowUpdate(ctx.repository, {
            wants: ctx.state.wants,
            clientShallow: req.shallow,
            depth: req.deepen,
            deepenRelative: req.deepenRelative,
            deepenSince: req.deepenSince,
            deepenNot,
            tips: [...(await ctx.refStore.listAll())].map(([, oid]) => oid),
          });
        } catch (e) {
          if (!(e instanceof UploadPackRequestError)) throw e;
          ctx.output.error = e.message;
          return "INVALID_REQUEST";
        }
        (state as ServerV2State).shallowUpdate = update;
        ctx.state.serverShallow = new Set(update.shallow);
        ctx.state.serverUnshallow = new Set(update.unshallow);

        await ctx.transport.writeLine("shallow-info");

        for (const oid of update.shallow) {
          await ctx.transport.writeLine(`shallow ${oid}`);
        }
        for (const oid of update.unshallow) {
          await ctx.transport.writeLine(`unshallow ${oid}`);
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

        // Export pack, cut at the shallow boundary: the new shallow commits and the client's
        // own; the parents of unshallowed commits are tips of their own
        const thin = req?.thinPack ?? false;
        const common = ctx.state.commonBase ?? new Set<string>();
        const shallow = state.shallowUpdate;
        const wants = new Set(ctx.state.wants);
        for (const oid of shallow?.extraWants ?? []) if (!common.has(oid)) wants.add(oid);
        const packShallow =
          shallow?.packShallow ?? (req?.shallow.length ? new Set(req.shallow) : undefined);
        const packStream = ctx.repository.exportPack(wants, common, {
          thin,
          ofsDelta: req?.ofsDeltas ?? false,
          includeTag: req?.includeTags,
          filterSpec: req?.filter ?? undefined,
          shallow: packShallow,
        });

        // The packfile section is side-band multiplexed (seeded as side-band-64k by the
        // server): keep-alives until the first byte, an error on band 3 after it
        const sent = await sendPackStream(ctx.transport, packStream, {
          sideband: ctx.state.capabilities.has("side-band-64k"),
          progress: false,
          keepAliveMs: ctx.config.keepAliveMs,
        });
        if (sent.ok) return "PACKFILE_SENT";
        ctx.output.error = sent.error;
        // without side-band the client must see a broken stream, not a short pack
        if (!sent.inBand) ctx.output.streamBroken = true;
        return "ERROR";
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
  /** The response carries an acknowledgments section ending in "ready" */
  sendAcks?: boolean;
  /** The shallow-info sent, and how the pack is cut to match it */
  shallowUpdate?: ShallowUpdate;
}

/** Whether the advertised `fetch=` capability lists `feature`. */
function advertisesFetchFeature(ctx: ProcessContext, feature: string): boolean {
  const capabilities = ctx.config.serverCapabilities ?? SERVER_V2_CAPABILITIES;
  const fetch = capabilities.find((c) => c === "fetch" || c.startsWith("fetch="));
  return fetch?.slice("fetch=".length).split(" ").includes(feature) ?? false;
}

/**
 * A `deepen-not` ref, expanded as git's `expand_ref` (the name, refs/<name>, tags, heads,
 * remotes, a remote's HEAD); undefined unless exactly one ref matches (git: "ambiguous").
 */
export async function resolveDeepenNot(
  refStore: ProcessContext["refStore"],
  name: string,
): Promise<string | undefined> {
  const found: string[] = [];
  for (const candidate of [
    name,
    `refs/${name}`,
    `refs/tags/${name}`,
    `refs/heads/${name}`,
    `refs/remotes/${name}`,
    `refs/remotes/${name}/HEAD`,
  ]) {
    const oid = await refStore.get(candidate);
    if (oid) found.push(oid);
  }
  return found.length === 1 ? found[0] : undefined;
}
