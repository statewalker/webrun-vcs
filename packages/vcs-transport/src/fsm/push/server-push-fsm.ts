/**
 * Server Push FSM for git-receive-pack operations.
 *
 * Handles the server side of push operations:
 * 1. Send advertisement (refs + capabilities)
 * 2. Read push commands from client
 * 3. Read push options (if negotiated)
 * 4. Receive and unpack pack file
 * 5. Validate commands and check connectivity
 * 6. Run hooks and apply ref updates
 * 7. Send status report
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
import type { ProtocolState } from "../../context/protocol-state.js";
import { encodeFlush, encodePacketLine } from "../../protocol/pkt-line-codec.js";
import type { FsmStateHandler, FsmTransition } from "../types.js";
import { type PushCommand, type PushCommandType, ZERO_OID } from "./types.js";

/**
 * Server push FSM transitions.
 */
export const serverPushTransitions: FsmTransition[] = [
  // Entry point
  ["", "START", "SEND_ADVERTISEMENT"],

  // Send refs and capabilities to client
  ["SEND_ADVERTISEMENT", "REFS_SENT", "READ_COMMANDS"],
  ["SEND_ADVERTISEMENT", "EMPTY_REPO", "READ_COMMANDS"],
  ["SEND_ADVERTISEMENT", "ERROR", ""],

  // Read push commands from client
  ["READ_COMMANDS", "COMMANDS_RECEIVED", "READ_PUSH_OPTIONS"],
  ["READ_COMMANDS", "COMMANDS_WITH_DELETE", "CHECK_DELETE_ALLOWED"],
  ["READ_COMMANDS", "NO_COMMANDS", ""], // Client sent nothing
  ["READ_COMMANDS", "ERROR", ""],

  // Check if delete is allowed
  ["CHECK_DELETE_ALLOWED", "DELETE_ALLOWED", "READ_PUSH_OPTIONS"],
  ["CHECK_DELETE_ALLOWED", "DELETE_DENIED", "REJECT_COMMANDS"],

  // Read push options (if push-options capability negotiated)
  ["READ_PUSH_OPTIONS", "OPTIONS_RECEIVED", "RECEIVE_PACK"],
  ["READ_PUSH_OPTIONS", "NO_OPTIONS", "RECEIVE_PACK"],
  ["READ_PUSH_OPTIONS", "ERROR", ""],

  // Receive pack file from client
  ["RECEIVE_PACK", "PACK_RECEIVED", "UNPACK"],
  ["RECEIVE_PACK", "EMPTY_PACK", "VALIDATE_COMMANDS"], // Delete-only
  ["RECEIVE_PACK", "ERROR", ""],

  // Unpack and store objects
  ["UNPACK", "UNPACK_OK", "CHECK_CONNECTIVITY"],
  ["UNPACK", "UNPACK_FAILED", "SEND_STATUS"],
  ["UNPACK", "ERROR", ""],

  // Check connectivity (all objects reachable)
  ["CHECK_CONNECTIVITY", "CONNECTIVITY_OK", "VALIDATE_COMMANDS"],
  ["CHECK_CONNECTIVITY", "CONNECTIVITY_FAILED", "REJECT_COMMANDS"],
  ["CHECK_CONNECTIVITY", "ERROR", ""],

  // Validate all commands
  ["VALIDATE_COMMANDS", "ALL_VALID", "RUN_PRE_RECEIVE_HOOK"],
  ["VALIDATE_COMMANDS", "SOME_INVALID", "RUN_PRE_RECEIVE_HOOK"], // Partial execution
  ["VALIDATE_COMMANDS", "ALL_INVALID", "SEND_STATUS"],
  ["VALIDATE_COMMANDS", "ERROR", ""],

  // Reject commands (used for fatal errors)
  ["REJECT_COMMANDS", "REJECTED", "SEND_STATUS"],

  // Pre-receive hook
  ["RUN_PRE_RECEIVE_HOOK", "HOOK_OK", "APPLY_UPDATES"],
  ["RUN_PRE_RECEIVE_HOOK", "HOOK_REJECTED", "SEND_STATUS"],
  ["RUN_PRE_RECEIVE_HOOK", "HOOK_ERROR", "SEND_STATUS"],
  ["RUN_PRE_RECEIVE_HOOK", "NO_HOOK", "APPLY_UPDATES"],
  ["RUN_PRE_RECEIVE_HOOK", "ERROR", ""],

  // Apply ref updates
  ["APPLY_UPDATES", "UPDATES_APPLIED", "RUN_POST_RECEIVE_HOOK"],
  ["APPLY_UPDATES", "PARTIAL_APPLIED", "RUN_POST_RECEIVE_HOOK"], // Some failed
  ["APPLY_UPDATES", "ATOMIC_FAILED", "SEND_STATUS"], // Atomic push failed
  ["APPLY_UPDATES", "ERROR", ""],

  // Post-receive hook
  ["RUN_POST_RECEIVE_HOOK", "HOOK_DONE", "SEND_STATUS"],
  ["RUN_POST_RECEIVE_HOOK", "NO_HOOK", "SEND_STATUS"],

  // Send status report
  ["SEND_STATUS", "STATUS_SENT", ""],
  ["SEND_STATUS", "ERROR", ""],
];

/**
 * Server push FSM handlers.
 */
export const serverPushHandlers = new Map<string, FsmStateHandler<ProcessContext>>([
  // Initial handler
  ["", async () => "START"],

  // Send advertisement to client
  [
    "SEND_ADVERTISEMENT",
    async (ctx) => {
      const transport = getTransport(ctx);
      const refStore = getRefStore(ctx);
      const state = getState(ctx);
      const output = getOutput(ctx);
      try {
        const refs = await refStore.listAll();
        const capabilities = [
          "report-status",
          "delete-refs",
          "ofs-delta",
          "side-band-64k",
          "atomic",
          "push-options",
          "quiet",
        ];

        let first = true;
        const refsArray = Array.from(refs);

        // Empty repository
        if (refsArray.length === 0) {
          await transport.writeLine(`${ZERO_OID} capabilities^{}\0${capabilities.join(" ")}`);
          await transport.writeFlush();
          // Don't pre-add server capabilities to state.capabilities.
          // READ_COMMANDS will populate it with the client's negotiated caps.
          return "EMPTY_REPO";
        }

        for (const [name, oid] of refsArray) {
          const line = first ? `${oid} ${name}\0${capabilities.join(" ")}` : `${oid} ${name}`;
          await transport.writeLine(line);
          state.refs.set(name, oid);
          first = false;
        }
        await transport.writeFlush();
        // Don't pre-add server capabilities to state.capabilities.
        // READ_COMMANDS will populate it with the client's negotiated caps.
        return "REFS_SENT";
      } catch (e) {
        output.error = String(e);
        return "ERROR";
      }
    },
  ],

  // Read push commands from client
  [
    "READ_COMMANDS",
    async (ctx) => {
      const transport = getTransport(ctx);
      const state = getState<ServerPushState>(ctx);
      const output = getOutput(ctx);
      try {
        const pushCommands: PushCommand[] = [];
        let hasDelete = false;

        while (true) {
          const pkt = await transport.readPktLine();
          if (pkt.type === "flush") break;
          if (pkt.type === "eof") {
            output.error = "Unexpected end of input";
            return "ERROR";
          }
          if (pkt.type === "delim") {
            continue; // Unexpected delimiter in push commands
          }

          const line = pkt.text;

          // Parse command: old-oid SP new-oid SP refname\0caps
          // Cannot use split(" ", 3) — JS split with limit truncates remaining text.
          // e.g., "a b c d".split(" ", 3) → ["a", "b", "c"] NOT ["a", "b", "c d"]
          const sp1 = line.indexOf(" ");
          const sp2 = line.indexOf(" ", sp1 + 1);
          const oldOid = line.slice(0, sp1);
          const newOid = line.slice(sp1 + 1, sp2);
          let refName = line.slice(sp2 + 1);

          // Parse capabilities from first command
          if (refName.includes("\0")) {
            const nullIdx = refName.indexOf("\0");
            const caps = refName.slice(nullIdx + 1);
            refName = refName.slice(0, nullIdx);
            for (const c of caps.split(" ")) {
              state.capabilities.add(c);
            }
          }

          // Determine command type
          let type: PushCommandType;
          if (newOid === ZERO_OID) {
            type = "DELETE";
            hasDelete = true;
          } else if (oldOid === ZERO_OID) {
            type = "CREATE";
          } else {
            type = "UPDATE"; // Will validate fast-forward later
          }

          pushCommands.push({
            oldOid,
            newOid,
            refName,
            type,
            result: "NOT_ATTEMPTED",
          });
        }

        state.pushCommands = pushCommands;

        if (pushCommands.length === 0) {
          return "NO_COMMANDS";
        }

        return hasDelete ? "COMMANDS_WITH_DELETE" : "COMMANDS_RECEIVED";
      } catch (e) {
        output.error = String(e);
        return "ERROR";
      }
    },
  ],

  // Check if delete is allowed
  [
    "CHECK_DELETE_ALLOWED",
    async (ctx) => {
      const state = getState<ServerPushState>(ctx);
      const config = getConfig(ctx);
      const output = getOutput(ctx);
      try {
        if (config.allowDeletes === false && !state.capabilities.has("delete-refs")) {
          // Mark delete commands as rejected
          for (const cmd of state.pushCommands ?? []) {
            if (cmd.type === "DELETE") {
              cmd.result = "REJECTED_NODELETE";
              cmd.message = "deletion prohibited";
            }
          }
          return "DELETE_DENIED";
        }
        return "DELETE_ALLOWED";
      } catch (e) {
        output.error = String(e);
        return "ERROR";
      }
    },
  ],

  // Read push options
  [
    "READ_PUSH_OPTIONS",
    async (ctx) => {
      const transport = getTransport(ctx);
      const state = getState<ServerPushState>(ctx);
      const output = getOutput(ctx);
      try {
        if (!state.capabilities.has("push-options")) {
          return "NO_OPTIONS";
        }

        const pushOptions: string[] = [];

        while (true) {
          const pkt = await transport.readPktLine();
          if (pkt.type === "flush") break;
          if (pkt.type === "eof") {
            output.error = "Unexpected end of input";
            return "ERROR";
          }
          if (pkt.type === "delim") {
            continue; // Unexpected delimiter in push options
          }
          pushOptions.push(pkt.text);
        }

        state.pushOptions = pushOptions;
        return "OPTIONS_RECEIVED";
      } catch (e) {
        output.error = String(e);
        return "ERROR";
      }
    },
  ],

  // Receive pack from client
  [
    "RECEIVE_PACK",
    async (ctx) => {
      const transport = getTransport(ctx);
      const state = getState<ServerPushState>(ctx);
      const output = getOutput(ctx);
      try {
        // Check if pack is expected (not for delete-only)
        const expectPack = (state.pushCommands ?? []).some((cmd) => cmd.type !== "DELETE");

        if (!expectPack) {
          return "EMPTY_PACK";
        }

        // Store pack stream on state for UNPACK handler.
        // Use readRawPack() because the client sends raw pack data
        // after the pkt-line commands, regardless of sideband capability.
        // Sideband is only used for the server's response direction.
        state.packStream = transport.readRawPack();
        return "PACK_RECEIVED";
      } catch (e) {
        output.error = String(e);
        return "ERROR";
      }
    },
  ],

  // Unpack and store objects
  [
    "UNPACK",
    async (ctx) => {
      const repository = getRepository(ctx);
      const output = getOutput(ctx);
      try {
        const state = getState<ServerPushState>(ctx);
        if (state.packStream) {
          const result = await repository.importPack(state.packStream);
          output.packResult = result;
        }
        return "UNPACK_OK";
      } catch (e) {
        output.error = String(e);
        return "UNPACK_FAILED";
      }
    },
  ],

  // Check connectivity
  [
    "CHECK_CONNECTIVITY",
    async (ctx) => {
      const repository = getRepository(ctx);
      const output = getOutput(ctx);
      try {
        const state = getState<ServerPushState>(ctx);

        for (const cmd of state.pushCommands ?? []) {
          if (cmd.type === "DELETE") continue;

          // Check if new objects are reachable
          const exists = await repository.has(cmd.newOid);
          if (!exists) {
            cmd.result = "REJECTED_MISSING_OBJECT";
            cmd.message = "missing necessary objects";
          }
        }

        const anyMissing = (state.pushCommands ?? []).some(
          (c) => c.result === "REJECTED_MISSING_OBJECT",
        );
        return anyMissing ? "CONNECTIVITY_FAILED" : "CONNECTIVITY_OK";
      } catch (e) {
        output.error = String(e);
        return "ERROR";
      }
    },
  ],

  // Validate commands
  [
    "VALIDATE_COMMANDS",
    async (ctx) => {
      const state = getState<ServerPushState>(ctx);
      const repository = getRepository(ctx);
      const config = getConfig(ctx);
      const output = getOutput(ctx);
      try {
        let invalidCount = 0;

        for (const cmd of state.pushCommands ?? []) {
          // Skip already rejected
          if (cmd.result !== "NOT_ATTEMPTED") {
            invalidCount++;
            continue;
          }

          // Validate old OID matches current ref
          const currentOid = state.refs.get(cmd.refName) ?? ZERO_OID;
          if (cmd.oldOid !== currentOid) {
            cmd.result = "REJECTED_NONFASTFORWARD";
            cmd.message = "remote ref changed since fetch";
            invalidCount++;
            continue;
          }

          // For updates, check fast-forward (unless config allows non-ff)
          if (cmd.type === "UPDATE") {
            // Walk ancestry from newOid to verify oldOid is a proper ancestor.
            // Just checking repository.has(oldOid) only verifies object existence,
            // not that newOid descends from oldOid.
            let isFastForward = false;
            for await (const ancestorOid of repository.walkAncestors(cmd.newOid)) {
              if (ancestorOid === cmd.oldOid) {
                isFastForward = true;
                break;
              }
            }
            if (!isFastForward && !config.allowNonFastForward) {
              cmd.result = "REJECTED_NONFASTFORWARD";
              cmd.message = "non-fast-forward";
              invalidCount++;
              continue;
            }
            if (!isFastForward) {
              cmd.type = "UPDATE_NONFASTFORWARD";
            }
          }

          // Check if updating current branch
          if (config.denyCurrentBranch && cmd.refName === config.currentBranch) {
            cmd.result = "REJECTED_CURRENT_BRANCH";
            cmd.message = "refusing to update checked out branch";
            invalidCount++;
          }
        }

        if (invalidCount === (state.pushCommands ?? []).length) {
          return "ALL_INVALID";
        }
        if (invalidCount > 0) {
          return "SOME_INVALID";
        }
        return "ALL_VALID";
      } catch (e) {
        output.error = String(e);
        return "ERROR";
      }
    },
  ],

  // Reject all commands
  [
    "REJECT_COMMANDS",
    async (ctx) => {
      const state = getState<ServerPushState>(ctx);
      const output = getOutput(ctx);
      try {
        const reason = output.error ?? "rejected";

        for (const cmd of state.pushCommands ?? []) {
          // Only reject commands that haven't been rejected yet
          if (cmd.result === "NOT_ATTEMPTED") {
            cmd.result = "REJECTED_OTHER_REASON";
            cmd.message = reason;
          }
        }
        return "REJECTED";
      } catch (e) {
        output.error = String(e);
        return "ERROR";
      }
    },
  ],

  // Run pre-receive hook
  [
    "RUN_PRE_RECEIVE_HOOK",
    async (ctx) => {
      const state = getState<ServerPushState>(ctx);
      const output = getOutput(ctx);
      try {
        const hooks = (ctx as ContextWithHooks).hooks;

        if (!hooks?.preReceive) {
          return "NO_HOOK";
        }

        const validCommands = (state.pushCommands ?? []).filter(
          (cmd) => cmd.result === "NOT_ATTEMPTED",
        );

        if (validCommands.length === 0) {
          return "NO_HOOK";
        }

        const result = await hooks.preReceive(validCommands, state.pushOptions);

        if (!result.ok) {
          // Reject specified refs or all
          const rejectedRefs = new Set(result.rejectedRefs ?? validCommands.map((c) => c.refName));
          for (const cmd of state.pushCommands ?? []) {
            if (rejectedRefs.has(cmd.refName) && cmd.result === "NOT_ATTEMPTED") {
              cmd.result = "REJECTED_OTHER_REASON";
              cmd.message = result.message ?? "pre-receive hook rejected";
            }
          }
          return "HOOK_REJECTED";
        }

        return "HOOK_OK";
      } catch (e) {
        output.error = String(e);
        return "HOOK_ERROR";
      }
    },
  ],

  // Apply ref updates
  [
    "APPLY_UPDATES",
    async (ctx) => {
      const state = getState<ServerPushState>(ctx);
      const refStore = getRefStore(ctx);
      const output = getOutput(ctx);
      try {
        const atomic = state.capabilities.has("atomic");

        let failedCount = 0;
        const appliedCommands: PushCommand[] = [];

        for (const cmd of state.pushCommands ?? []) {
          if (cmd.result !== "NOT_ATTEMPTED") {
            failedCount++;
            continue;
          }

          try {
            if (cmd.type === "DELETE") {
              // Delete ref - refStore.update should handle this
              await refStore.update(cmd.refName, ZERO_OID);
            } else {
              await refStore.update(cmd.refName, cmd.newOid);
            }
            cmd.result = "OK";
            appliedCommands.push(cmd);
          } catch (e) {
            cmd.result = "LOCK_FAILURE";
            cmd.message = e instanceof Error ? e.message : "update failed";
            failedCount++;

            // If atomic, abort all
            if (atomic) {
              // Rollback applied updates (best effort)
              for (const applied of appliedCommands) {
                try {
                  await refStore.update(applied.refName, applied.oldOid);
                  applied.result = "ATOMIC_REJECTED";
                  applied.message = "atomic push failed";
                } catch {
                  // Rollback failed, continue
                }
              }
              return "ATOMIC_FAILED";
            }
          }
        }

        state.appliedCommands = appliedCommands;

        if (failedCount === 0) {
          return "UPDATES_APPLIED";
        }
        return "PARTIAL_APPLIED";
      } catch (e) {
        output.error = String(e);
        return "ERROR";
      }
    },
  ],

  // Run post-receive hook
  [
    "RUN_POST_RECEIVE_HOOK",
    async (ctx) => {
      const state = getState<ServerPushState>(ctx);
      try {
        const hooks = (ctx as ContextWithHooks).hooks;

        if (!hooks?.postReceive) {
          return "NO_HOOK";
        }

        const appliedCommands = state.appliedCommands ?? [];
        if (appliedCommands.length > 0) {
          await hooks.postReceive(appliedCommands, state.pushOptions);
        }

        return "HOOK_DONE";
      } catch {
        // Post-receive hook errors are non-fatal
        return "HOOK_DONE";
      }
    },
  ],

  // Send status report
  [
    "SEND_STATUS",
    async (ctx) => {
      const transport = getTransport(ctx);
      const state = getState<ServerPushState>(ctx);
      const output = getOutput(ctx);
      try {
        const useSideband = state.capabilities.has("side-band-64k");
        const unpackOk = !output.error?.includes("Unpack");

        if (useSideband) {
          // With sideband, each status line must be pkt-line encoded
          // before being wrapped in the sideband frame. The client
          // demuxes sideband, then parses the inner pkt-line stream.
          const unpackLine = unpackOk ? "unpack ok" : `unpack ${output.error}`;
          await transport.writeSideband(1, encodePacketLine(unpackLine));

          for (const cmd of state.pushCommands ?? []) {
            const line =
              cmd.result === "OK"
                ? `ok ${cmd.refName}`
                : `ng ${cmd.refName} ${cmd.message || "rejected"}`;
            await transport.writeSideband(1, encodePacketLine(line));
          }

          // Send inner flush on channel 1 to terminate the report-status
          await transport.writeSideband(1, encodeFlush());
        } else {
          // Send status directly
          if (unpackOk) {
            await transport.writeLine("unpack ok");
          } else {
            await transport.writeLine(`unpack ${output.error || "failed"}`);
          }

          for (const cmd of state.pushCommands ?? []) {
            if (cmd.result === "OK") {
              await transport.writeLine(`ok ${cmd.refName}`);
            } else {
              await transport.writeLine(`ng ${cmd.refName} ${cmd.message || "rejected"}`);
            }
          }
        }

        await transport.writeFlush();
        return "STATUS_SENT";
      } catch (e) {
        output.error = String(e);
        return "ERROR";
      }
    },
  ],
]);

/**
 * Extended state for server push operations.
 */
interface ServerPushState extends ProtocolState {
  pushCommands?: PushCommand[];
  pushOptions?: string[];
  packStream?: AsyncIterable<Uint8Array>;
  appliedCommands?: PushCommand[];
}

/**
 * Context with hooks support.
 */
interface ContextWithHooks extends ProcessContext {
  hooks?: {
    preReceive?: (
      commands: PushCommand[],
      options?: string[],
    ) => Promise<{
      ok: boolean;
      message?: string;
      rejectedRefs?: string[];
    }>;
    postReceive?: (commands: PushCommand[], options?: string[]) => Promise<void>;
  };
}
