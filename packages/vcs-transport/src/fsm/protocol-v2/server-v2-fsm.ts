/**
 * Protocol V2 Server FSM.
 *
 * Handles the server side of Git protocol V2:
 * 1. Send capability advertisement
 * 2. Read and handle commands (ls-refs, fetch, object-info)
 * 3. Send appropriate responses
 */

import type { PktLineResult } from "../../api/transport-api.js";
import type { ProcessContext } from "../../context/process-context.js";
import { isRefHidden, visibleRefs } from "../../protocol/hidden-refs.js";
import {
  authorizeUpload,
  computeShallowUpdate,
  findUnreachableWant,
  includeTagCandidates,
  notifyUpload,
  notOurRef,
  okToGiveUp,
  peelFully,
  resolveDeepenNot,
  type ShallowUpdate,
  sendPackStream,
  UploadPackRequestError,
  type UploadPackRequestParts,
} from "../fetch/index.js";
import type { FsmStateHandler, FsmTransition } from "../types.js";
import {
  createEmptyFetchRequest,
  type FetchV2Request,
  objectInfoAttributes,
  serverV2Capabilities,
} from "./types.js";

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

        for (const cap of advertisedCapabilities(ctx)) {
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

  // Read a command request: `command=<name>` and capability lines (in any order), up to the
  // delimiter that starts the arguments, or a flush (a command without arguments), as git's
  // serve.c process_request
  [
    "READ_COMMAND",
    async (ctx) => {
      try {
        const state = ctx.state as ServerV2State;
        // stateless-rpc (smart HTTP): one command per request, as git's serve loop
        if (ctx.config.statelessRpc && state.commandServed) return "FLUSH";

        let command: string | undefined;
        let seen = false;
        let clientFormat: string | undefined;
        while (true) {
          const pkt = await ctx.transport.readPktLine();
          if (pkt.type === "eof") {
            if (!seen) return "FLUSH";
            ctx.output.error = "the remote end hung up unexpectedly";
            return "ERROR";
          }
          if (pkt.type === "flush") {
            // nothing requested: the client ends the session
            if (!seen) return "FLUSH";
            // the command reads this flush as the end of its (empty) arguments
            state.argumentsEnded = true;
            break;
          }
          if (pkt.type === "delim") break;

          const line = pkt.text;
          if (line.startsWith("command=")) {
            const name = line.slice("command=".length);
            if (command !== undefined) {
              ctx.output.error = `command '${name}' requested after already requesting command '${command}'`;
              return "ERROR";
            }
            if (!V2_COMMANDS.has(name) || !advertisesCapability(ctx, name)) {
              ctx.output.error = `invalid command '${name}'`;
              return "ERROR";
            }
            command = name;
          } else if (line.startsWith("object-format=")) {
            clientFormat = line.slice("object-format=".length);
            if (!KNOWN_OBJECT_FORMATS.has(clientFormat)) {
              ctx.output.error = `unknown object format '${clientFormat}'`;
              return "ERROR";
            }
          }
          // other capability lines (agent, server-option, session-id, ...) are accepted
          seen = true;
        }

        if (command === undefined) {
          ctx.output.error = "no command requested";
          return "ERROR";
        }
        // a client that names no object format speaks sha1 (git)
        const serverFormat = serverObjectFormat(ctx);
        if ((clientFormat ?? "sha1") !== serverFormat) {
          ctx.output.error = `mismatched object format: server ${serverFormat}; client ${clientFormat ?? "sha1"}`;
          return "ERROR";
        }

        state.commandServed = true;
        ctx.state.currentCommand = command;
        if (command === "ls-refs") return "LS_REFS";
        if (command === "fetch") return "FETCH";
        return "OBJECT_INFO";
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
          const pkt = await readArgument(ctx);
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

        // Get refs: hidden ones are not listed (git's ls-refs with hideRefs)
        const allRefs = visibleRefs(await ctx.refStore.listAll(), ctx.config.hiddenRefs);
        const matches = (name: string) =>
          refPrefixes.length === 0 || refPrefixes.some((p) => name.startsWith(p));

        // An unborn HEAD (a symref to a branch with no commit yet) comes first, as git's
        // send_possibly_unborn_head: only with both `unborn` (and advertised) and `symrefs`
        if (
          unborn &&
          symrefs &&
          advertisesFeature(ctx, "ls-refs", "unborn") &&
          matches("HEAD") &&
          !allRefs.some(([name]) => name === "HEAD") &&
          ctx.refStore.getSymrefTarget
        ) {
          const headTarget = await ctx.refStore.getSymrefTarget("HEAD");
          if (headTarget) {
            await ctx.transport.writeLine(`unborn HEAD symref-target:${headTarget}`);
          }
        }

        // Send refs
        for (const [name, oid] of allRefs) {
          if (!matches(name)) continue;
          let line = `${oid} ${name}`;

          if (symrefs && ctx.refStore.getSymrefTarget) {
            const target = await ctx.refStore.getSymrefTarget(name);
            if (target) {
              line += ` symref-target:${target}`;
            }
          }
          if (peel) {
            // fully peeled, through a chain of tags (git's peel_iterated_oid)
            const peeled = await peelFully(ctx.repository, oid);
            if (peeled) line += ` peeled:${peeled}`;
          }

          await ctx.transport.writeLine(line);
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
          const pkt = await readArgument(ctx);
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

        // Resolve want-refs to OIDs; a hidden ref is unknown (git's parse_want_ref)
        for (const refName of req.wantRefs) {
          const oid = isRefHidden(refName, ctx.config.hiddenRefs)
            ? undefined
            : await ctx.refStore.get(refName);
          if (!oid) {
            ctx.output.error = `unknown ref ${refName}`;
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

        // Direct wants: by default any object the repository has, as git's v2 upload-pack
        // (its parse_want refuses only a missing object, whatever uploadpack.allow* say); a
        // stricter policy is ours. "not our ref" for anything refused
        const policy = ctx.config.requestPolicy ?? "ANY";
        const allRefs = [...(await ctx.refStore.listAll())];
        // every tip, hidden ones too (git's allowTipSHA1InWant / allowReachableSHA1InWant)
        const tips = allRefs.map(([, oid]) => oid);
        let refused: string | undefined;
        if (policy === "ANY") {
          for (const oid of req.wants) {
            if (!(await ctx.repository.has(oid))) {
              refused = oid;
              break;
            }
          }
        } else if (policy === "ADVERTISED" || policy === "TIP") {
          const tipSet = new Set(
            policy === "TIP"
              ? tips
              : visibleRefs(allRefs, ctx.config.hiddenRefs).map(([, oid]) => oid),
          );
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

        // the authorize hook decides before the response
        const denied = await authorizeUpload(
          ctx.config,
          ctx.refStore,
          ctx.repository,
          uploadRequest(ctx),
        );
        if (denied !== undefined) {
          ctx.output.error = denied;
          return "INVALID_WANT";
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
          // git's pack-objects --include-tag: the visible annotated tags of packed objects
          includeTags: req?.includeTags
            ? await includeTagCandidates(ctx.config, ctx.refStore)
            : undefined,
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
        if (sent.ok) {
          notifyUpload(ctx.config, ctx.refStore, ctx.repository, uploadRequest(ctx), {
            common,
            packBytes: sent.bytes,
          });
          return "PACKFILE_SENT";
        }
        ctx.output.error = sent.error;
        // reported on band 3; without side-band the client must see a broken stream, not a
        // short pack
        if (sent.inBand) ctx.output.errorReported = true;
        else ctx.output.streamBroken = true;
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
        let size = false;
        let type = false;

        // Read arguments until flush (git's cap_object_info)
        while (true) {
          const pkt = await readArgument(ctx);
          if (pkt.type === "flush") break;
          if (pkt.type === "delim") continue;
          if (pkt.type === "eof") {
            ctx.output.error = "object-info: expected flush after arguments";
            return "ERROR";
          }

          const line = pkt.text;
          // an attribute the facade cannot answer is an unknown line (as 2.43 for `type`)
          const supported = objectInfoAttributes(ctx.repository);
          if (line === "size" && supported.includes("size")) size = true;
          else if (line === "type" && supported.includes("type")) type = true;
          else if (line.startsWith("oid ")) objectIds.push(line.slice(4));
          else await writeRaw(ctx, `ERR object-info: unexpected line: '${line}'`);
        }

        // git's send_info: nothing for no oid; the attribute lines asked for (`size`, then
        // `type`); then a line per requested oid, in order, written as git writes them (no
        // newline): "<oid> <size> <type>" with the attributes asked for, "<oid> " for an
        // object it does not have; an ERR for what is not an oid
        if (objectIds.length > 0) {
          if (size) await writeRaw(ctx, "size");
          if (type) await writeRaw(ctx, "type");
          for (const oid of objectIds) {
            if (!OID_PATTERN.test(oid)) {
              await writeRaw(
                ctx,
                `ERR object-info: protocol error, expected to get oid, not '${oid}'`,
              );
              continue;
            }
            const info = await objectInfo(ctx, oid, size, type);
            if (info === null) {
              await writeRaw(ctx, `${oid} `);
              continue;
            }
            await writeRaw(ctx, [oid, ...info].join(" "));
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
        // git's packet_writer_error, then it dies: no newline, no flush
        await writeRaw(ctx, `ERR ${errorMsg}`);
        ctx.output.errorReported = true;
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
  /** READ_COMMAND consumed the flush that ends the command's (empty) arguments */
  argumentsEnded?: boolean;
  /** A command was read (stateless-rpc serves one per request) */
  commandServed?: boolean;
  fetchRequest?: FetchV2Request;
  /** The response carries an acknowledgments section ending in "ready" */
  sendAcks?: boolean;
  /** The shallow-info sent, and how the pack is cut to match it */
  shallowUpdate?: ShallowUpdate;
}

/** The current fetch command as upload-pack's hooks see it. */
function uploadRequest(ctx: ProcessContext): UploadPackRequestParts {
  const req = (ctx.state as ServerV2State).fetchRequest;
  const capabilities = new Set<string>();
  if (req?.thinPack) capabilities.add("thin-pack");
  if (req?.noProgress) capabilities.add("no-progress");
  if (req?.includeTags) capabilities.add("include-tag");
  if (req?.ofsDeltas) capabilities.add("ofs-delta");
  if (req?.deepenRelative) capabilities.add("deepen-relative");
  if (req?.waitForDone) capabilities.add("wait-for-done");
  return {
    protocolVersion: 2,
    wants: [...ctx.state.wants],
    wantRefs: new Map(ctx.state.wantedRefs ?? []),
    haves: [...(req?.haves ?? [])],
    capabilities,
    shallow: [...(req?.shallow ?? [])],
    depth: req?.deepen ?? 0,
    ...(req?.filter != null ? { filter: req.filter } : {}),
  };
}

/** The commands the v2 server implements. */
const V2_COMMANDS = new Set(["ls-refs", "fetch", "object-info"]);

/** Object formats git knows (`object-format=` of a request). */
const KNOWN_OBJECT_FORMATS = new Set(["sha1", "sha256"]);

const OID_PATTERN = /^[0-9a-f]{40}$/;

const textEncoder = new TextEncoder();

/** The next argument line of the current command (a flush READ_COMMAND already read counts). */
async function readArgument(ctx: ProcessContext): Promise<PktLineResult> {
  const state = ctx.state as ServerV2State;
  if (state.argumentsEnded) {
    state.argumentsEnded = false;
    return { type: "flush" };
  }
  return ctx.transport.readPktLine();
}

/** A pkt-line written as git's `packet_writer_write` does: the text, no newline added. */
function writeRaw(ctx: ProcessContext, text: string): Promise<void> {
  return ctx.transport.writePktLine(textEncoder.encode(text));
}

function advertisedCapabilities(ctx: ProcessContext): string[] {
  return serverV2Capabilities(
    ctx.config.serverCapabilities,
    ctx.config.advertiseObjectInfo,
    ctx.repository,
  );
}

/**
 * The attributes object-info asks for, in git's order (size, type), or null for an object the
 * repository does not have (git 2.56's send_info looks every object up, attributes or not;
 * 2.43 only for `size`).
 */
async function objectInfo(
  ctx: ProcessContext,
  oid: string,
  size: boolean,
  type: boolean,
): Promise<string[] | null> {
  const out: string[] = [];
  if (size) {
    const objectSize = (await ctx.repository.getObjectSize?.(oid)) ?? null;
    if (objectSize === null) return null;
    out.push(String(objectSize));
  }
  if (type) {
    const objectType = await ctx.repository.getObjectType?.(oid);
    if (objectType === undefined) return null;
    out.push(objectType);
  }
  if (!size && !type && !(await ctx.repository.has(oid))) return null;
  return out;
}

/** Whether the advertisement has capability `name` (`name` or `name=<features>`). */
function advertisesCapability(ctx: ProcessContext, name: string): boolean {
  return advertisedCapabilities(ctx).some((c) => c === name || c.startsWith(`${name}=`));
}

/** Whether the advertised `<capability>=` lists `feature` (e.g. `fetch=shallow`). */
function advertisesFeature(ctx: ProcessContext, capability: string, feature: string): boolean {
  const found = advertisedCapabilities(ctx).find((c) => c.startsWith(`${capability}=`));
  return (
    found
      ?.slice(capability.length + 1)
      .split(" ")
      .includes(feature) ?? false
  );
}

/** Whether the advertised `fetch=` capability lists `feature`. */
function advertisesFetchFeature(ctx: ProcessContext, feature: string): boolean {
  return advertisesFeature(ctx, "fetch", feature);
}

/** The server's object format (its `object-format=` capability; sha1 without one). */
function serverObjectFormat(ctx: ProcessContext): string {
  const found = advertisedCapabilities(ctx).find((c) => c.startsWith("object-format="));
  return found ? found.slice("object-format=".length) : "sha1";
}
