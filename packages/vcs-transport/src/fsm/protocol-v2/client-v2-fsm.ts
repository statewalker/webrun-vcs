/**
 * Protocol V2 Client FSM.
 *
 * Handles the client side of Git protocol V2:
 * 1. Read server capabilities
 * 2. Send ls-refs command
 * 3. Send fetch command
 * 4. Process response sections (acks, shallow-info, wanted-refs, packfile)
 * 5. Update local refs
 */

import type { ProcessContext } from "../../context/process-context.js";
import type { FsmStateHandler, FsmTransition } from "../types.js";
import type { FetchV2Request } from "./types.js";

/**
 * Client V2 FSM transitions.
 */
export const clientV2Transitions: FsmTransition[] = [
  // Entry: read server capabilities
  ["", "START", "READ_CAPABILITIES"],

  // Read server capability advertisement
  ["READ_CAPABILITIES", "CAPS_RECEIVED", "SEND_LS_REFS"],
  ["READ_CAPABILITIES", "ERROR", ""],

  // Send ls-refs command (ref discovery)
  ["SEND_LS_REFS", "LS_REFS_SENT", "READ_LS_REFS_RESPONSE"],
  ["SEND_LS_REFS", "SKIP_LS_REFS", "COMPUTE_WANTS"], // Skip if refs already known
  ["SEND_LS_REFS", "ERROR", ""],

  // Read ls-refs response
  ["READ_LS_REFS_RESPONSE", "REFS_RECEIVED", "COMPUTE_WANTS"],
  ["READ_LS_REFS_RESPONSE", "ERROR", ""],

  // Compute wants
  ["COMPUTE_WANTS", "WANTS_COMPUTED", "SEND_FETCH"],
  ["COMPUTE_WANTS", "NO_WANTS", ""], // Up to date

  // Send fetch command
  ["SEND_FETCH", "FETCH_SENT", "READ_FETCH_RESPONSE"],
  ["SEND_FETCH", "ERROR", ""],

  // Read fetch response (may need multiple rounds)
  ["READ_FETCH_RESPONSE", "ACKS_ONLY", "SEND_FETCH"], // More haves needed
  ["READ_FETCH_RESPONSE", "SHALLOW_INFO", "PROCESS_SHALLOW"], // Process shallow info
  ["READ_FETCH_RESPONSE", "WANTED_REFS", "PROCESS_REFS"], // Process wanted-refs
  ["READ_FETCH_RESPONSE", "PACKFILE", "RECEIVE_PACK"], // Pack follows
  ["READ_FETCH_RESPONSE", "PACKFILE_URIS", "FETCH_PACKFILE_URIS"], // CDN URIs
  ["READ_FETCH_RESPONSE", "ERROR", ""],

  // Process shallow info
  ["PROCESS_SHALLOW", "SHALLOW_PROCESSED", "READ_FETCH_RESPONSE"],

  // Process wanted-refs
  ["PROCESS_REFS", "REFS_PROCESSED", "READ_FETCH_RESPONSE"],

  // Fetch from CDN URIs (packfile-uri extension)
  ["FETCH_PACKFILE_URIS", "URIS_FETCHED", "RECEIVE_PACK"],
  ["FETCH_PACKFILE_URIS", "ERROR", ""],

  // Receive pack
  ["RECEIVE_PACK", "PACK_RECEIVED", "UPDATE_REFS"],
  ["RECEIVE_PACK", "ERROR", ""],

  // Update local refs
  ["UPDATE_REFS", "REFS_UPDATED", ""],
  ["UPDATE_REFS", "ERROR", ""],
];

/**
 * Client V2 FSM handlers.
 */
export const clientV2Handlers = new Map<string, FsmStateHandler<ProcessContext>>([
  // Initial handler
  ["", async () => "START"],

  // Read server capabilities
  [
    "READ_CAPABILITIES",
    async (ctx) => {
      try {
        while (true) {
          const pkt = await ctx.transport.readPktLine();
          if (pkt.type === "flush") break;
          if (pkt.type === "eof") {
            ctx.output.error = "Unexpected end of stream";
            return "ERROR";
          }
          if (pkt.type === "delim") {
            continue;
          }

          const line = pkt.text;

          // First line: version announcement
          if (line.startsWith("version 2")) {
            ctx.state.protocolVersion = 2;
            continue;
          }

          // Capability lines: "capability" or "capability=value"
          if (line.includes("=")) {
            const eqIdx = line.indexOf("=");
            const cap = line.slice(0, eqIdx);
            const value = line.slice(eqIdx + 1);
            ctx.state.capabilities.add(cap);
            ctx.state.capabilityValues = ctx.state.capabilityValues ?? new Map();
            ctx.state.capabilityValues.set(cap, value);
          } else {
            ctx.state.capabilities.add(line);
          }
        }

        return "CAPS_RECEIVED";
      } catch (e) {
        ctx.output.error = String(e);
        return "ERROR";
      }
    },
  ],

  // Send ls-refs command
  [
    "SEND_LS_REFS",
    async (ctx) => {
      try {
        // Skip if we already have refs
        if (ctx.state.refs.size > 0 && !ctx.config.forceRefFetch) {
          return "SKIP_LS_REFS";
        }

        await ctx.transport.writeLine("command=ls-refs");

        // Arguments delimiter
        await ctx.transport.writeDelimiter();

        // Options
        if (ctx.config.lsRefsSymrefs) {
          await ctx.transport.writeLine("symrefs");
        }
        if (ctx.config.lsRefsPeel) {
          await ctx.transport.writeLine("peel");
        }
        if (ctx.config.lsRefsUnborn) {
          await ctx.transport.writeLine("unborn");
        }

        // Ref prefixes
        const prefixes = ctx.config.refPrefixes ?? ["refs/heads/", "refs/tags/"];
        for (const prefix of prefixes) {
          await ctx.transport.writeLine(`ref-prefix ${prefix}`);
        }

        await ctx.transport.writeFlush();
        return "LS_REFS_SENT";
      } catch (e) {
        ctx.output.error = String(e);
        return "ERROR";
      }
    },
  ],

  // Read ls-refs response
  [
    "READ_LS_REFS_RESPONSE",
    async (ctx) => {
      try {
        while (true) {
          const pkt = await ctx.transport.readPktLine();
          if (pkt.type === "flush") break;
          if (pkt.type === "eof") {
            ctx.output.error = "Unexpected end of stream";
            return "ERROR";
          }
          if (pkt.type === "delim") {
            continue;
          }

          const line = pkt.text;
          // Format: <oid> <refname>[ <attribute>...]
          const parts = line.split(" ");
          const oid = parts[0];
          const refName = parts[1];

          ctx.state.refs.set(refName, oid);

          // Parse attributes (symref-target, peeled)
          for (let i = 2; i < parts.length; i++) {
            const attr = parts[i];
            if (attr.startsWith("symref-target:")) {
              ctx.state.symrefs = ctx.state.symrefs ?? new Map();
              ctx.state.symrefs.set(refName, attr.slice(14));
            } else if (attr.startsWith("peeled:")) {
              ctx.state.peeled = ctx.state.peeled ?? new Map();
              ctx.state.peeled.set(refName, attr.slice(7));
            }
          }
        }

        return "REFS_RECEIVED";
      } catch (e) {
        ctx.output.error = String(e);
        return "ERROR";
      }
    },
  ],

  // Compute wants
  [
    "COMPUTE_WANTS",
    async (ctx) => {
      try {
        for (const [ref, oid] of ctx.state.refs) {
          if (!(await ctx.repository.has(oid))) {
            ctx.state.wants.add(oid);
            ctx.state.wantedRefs = ctx.state.wantedRefs ?? new Map();
            ctx.state.wantedRefs.set(ref, oid);
          }
        }

        if (ctx.state.wants.size === 0) {
          return "NO_WANTS";
        }

        return "WANTS_COMPUTED";
      } catch (e) {
        ctx.output.error = String(e);
        return "ERROR";
      }
    },
  ],

  // Send fetch command
  [
    "SEND_FETCH",
    async (ctx) => {
      try {
        await ctx.transport.writeLine("command=fetch");

        // Arguments section
        await ctx.transport.writeDelimiter();

        // Capabilities/options
        if (ctx.state.capabilities.has("thin-pack")) {
          await ctx.transport.writeLine("thin-pack");
        }
        if (ctx.config.noProgress) {
          await ctx.transport.writeLine("no-progress");
        }
        if (ctx.state.capabilities.has("include-tag")) {
          await ctx.transport.writeLine("include-tag");
        }
        if (ctx.state.capabilities.has("ofs-delta")) {
          await ctx.transport.writeLine("ofs-delta");
        }

        // Wants (using want-ref if available)
        if (ctx.state.capabilities.has("want-ref") && ctx.state.wantedRefs) {
          for (const [ref] of ctx.state.wantedRefs) {
            await ctx.transport.writeLine(`want-ref ${ref}`);
          }
        } else {
          for (const oid of ctx.state.wants) {
            await ctx.transport.writeLine(`want ${oid}`);
          }
        }

        // Haves
        ctx.output.havesSent = ctx.output.havesSent ?? 0;
        const maxHaves = ctx.config.maxHaves ?? 256;

        if (ctx.config.localHead) {
          for await (const oid of ctx.repository.walkAncestors(ctx.config.localHead)) {
            if (ctx.output.havesSent >= maxHaves) break;
            if (ctx.state.commonBase?.has(oid)) continue;

            await ctx.transport.writeLine(`have ${oid}`);
            ctx.state.haves.add(oid);
            ctx.output.havesSent++;
          }
        }

        // Shallow options
        if (ctx.config.depth) {
          await ctx.transport.writeLine(`deepen ${ctx.config.depth}`);
          if (ctx.config.deepenRelative) {
            await ctx.transport.writeLine("deepen-relative");
          }
        }
        if (ctx.config.shallowSince) {
          await ctx.transport.writeLine(`deepen-since ${ctx.config.shallowSince}`);
        }
        for (const ref of ctx.config.shallowExclude ?? []) {
          await ctx.transport.writeLine(`deepen-not ${ref}`);
        }

        // Filter (partial clone)
        if (ctx.config.filter) {
          await ctx.transport.writeLine(`filter ${ctx.config.filter}`);
        }

        // Done (in stateless mode, always send done)
        if (ctx.config.statelessRpc || ctx.output.havesSent >= maxHaves) {
          await ctx.transport.writeLine("done");
          ctx.state.sentDone = true;
        }

        await ctx.transport.writeFlush();
        return "FETCH_SENT";
      } catch (e) {
        ctx.output.error = String(e);
        return "ERROR";
      }
    },
  ],

  // Read fetch response
  [
    "READ_FETCH_RESPONSE",
    async (ctx) => {
      try {
        while (true) {
          const pkt = await ctx.transport.readPktLine();

          if (pkt.type === "flush") {
            // End of response without packfile means more haves needed
            if (!ctx.state.sentDone) {
              return "ACKS_ONLY";
            }
            ctx.output.error = "Expected packfile but got flush";
            return "ERROR";
          }

          if (pkt.type === "delim") {
            continue;
          }

          if (pkt.type === "eof") {
            ctx.output.error = "Unexpected end of stream";
            return "ERROR";
          }

          const line = pkt.text;

          // Section headers
          if (line === "acknowledgments") {
            ctx.state.currentSection = "acknowledgments";
            continue;
          }
          if (line === "shallow-info") {
            ctx.state.currentSection = "shallow-info";
            return "SHALLOW_INFO";
          }
          if (line === "wanted-refs") {
            ctx.state.currentSection = "wanted-refs";
            return "WANTED_REFS";
          }
          if (line === "packfile-uris") {
            ctx.state.currentSection = "packfile-uris";
            ctx.state.packfileUris = [];
            continue;
          }
          if (line === "packfile") {
            return "PACKFILE";
          }

          // Section content
          if (ctx.state.currentSection === "acknowledgments") {
            if (line.startsWith("ACK ")) {
              const oid = line.slice(4);
              ctx.state.commonBase = ctx.state.commonBase ?? new Set();
              ctx.state.commonBase.add(oid);
            } else if (line === "ready") {
              ctx.state.serverReady = true;
            }
          } else if (ctx.state.currentSection === "packfile-uris") {
            ctx.state.packfileUris = ctx.state.packfileUris ?? [];
            ctx.state.packfileUris.push(line);
          }
        }
      } catch (e) {
        ctx.output.error = String(e);
        return "ERROR";
      }
    },
  ],

  // Process shallow info
  [
    "PROCESS_SHALLOW",
    async (ctx) => {
      try {
        while (true) {
          const pkt = await ctx.transport.readPktLine();
          if (pkt.type === "delim") break;
          if (pkt.type === "flush") {
            ctx.state.currentSection = undefined;
            break;
          }
          if (pkt.type === "eof") {
            ctx.output.error = "Unexpected end of stream";
            return "ERROR";
          }

          const line = pkt.text;
          if (line.startsWith("shallow ")) {
            ctx.state.clientShallow = ctx.state.clientShallow ?? new Set();
            ctx.state.clientShallow.add(line.slice(8));
          } else if (line.startsWith("unshallow ")) {
            ctx.state.serverUnshallow = ctx.state.serverUnshallow ?? new Set();
            ctx.state.serverUnshallow.add(line.slice(10));
          }
        }

        return "SHALLOW_PROCESSED";
      } catch (e) {
        ctx.output.error = String(e);
        return "ERROR";
      }
    },
  ],

  // Process wanted-refs
  [
    "PROCESS_REFS",
    async (ctx) => {
      try {
        ctx.state.resolvedWantedRefs = new Map();

        while (true) {
          const pkt = await ctx.transport.readPktLine();
          if (pkt.type === "delim") break;
          if (pkt.type === "flush") {
            ctx.state.currentSection = undefined;
            break;
          }
          if (pkt.type === "eof") {
            ctx.output.error = "Unexpected end of stream";
            return "ERROR";
          }

          const line = pkt.text;
          // Format: <oid> <refname>
          const spaceIdx = line.indexOf(" ");
          if (spaceIdx !== -1) {
            const oid = line.slice(0, spaceIdx);
            const refName = line.slice(spaceIdx + 1);
            ctx.state.resolvedWantedRefs.set(refName, oid);
          }
        }

        return "REFS_PROCESSED";
      } catch (e) {
        ctx.output.error = String(e);
        return "ERROR";
      }
    },
  ],

  // Fetch packfile URIs (CDN extension)
  [
    "FETCH_PACKFILE_URIS",
    async (ctx) => {
      try {
        // For now, just mark URIs as fetched
        // Actual CDN fetching would be implemented by the caller
        ctx.output.packfileUrisFetched = ctx.state.packfileUris?.length ?? 0;
        return "URIS_FETCHED";
      } catch (e) {
        ctx.output.error = String(e);
        return "ERROR";
      }
    },
  ],

  // Receive pack
  [
    "RECEIVE_PACK",
    async (ctx) => {
      try {
        const packStream = ctx.transport.readPack();
        const result = await ctx.repository.importPack(packStream);
        ctx.output.packResult = result;
        return "PACK_RECEIVED";
      } catch (e) {
        ctx.output.error = String(e);
        return "ERROR";
      }
    },
  ],

  // Update local refs
  [
    "UPDATE_REFS",
    async (ctx) => {
      try {
        // Use resolved wanted-refs if available, otherwise use refs from ls-refs
        const refsToUpdate = ctx.state.resolvedWantedRefs ?? ctx.state.wantedRefs ?? new Map();

        for (const [refName, oid] of refsToUpdate) {
          await ctx.refStore.update(refName, oid);
        }

        return "REFS_UPDATED";
      } catch (e) {
        ctx.output.error = String(e);
        return "ERROR";
      }
    },
  ],
]);

/**
 * Extended context state for V2 client operations.
 */
export interface V2ClientState {
  fetchRequest?: FetchV2Request;
  currentSection?: string;
  packfileUris?: string[];
  resolvedWantedRefs?: Map<string, string>;
}
