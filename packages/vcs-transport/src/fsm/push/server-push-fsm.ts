/**
 * Server Push FSM for git-receive-pack operations, as git's `builtin/receive-pack.c`.
 *
 * 1. Send the advertisement (refs + capabilities)
 * 2. Read the commands (and the client's `shallow` lines), then the push options
 * 3. Authorize the commands (the `authorize` hook), before any pack byte is read
 * 4. Receive and import the pack (unless every command needing it is refused, or a delete)
 * 5. Check connectivity (git's `check_connected`) and shallow updates
 * 6. Run the pre-receive hook
 * 7. Check each command as git's `update()` does (ref name, current branch, deletes,
 *    fast-forward, branch tips are commits, duplicates), then the per-ref update hook
 * 8. Apply the ref updates (one transaction when atomic)
 * 9. Send the status report, then start the post-receive hook (detached)
 *
 * The report texts are git's: `unpacker error`, `missing necessary objects`, `funny refname`,
 * `branch is currently checked out`, `deletion prohibited`, `deletion of the current branch
 * prohibited`, `non-fast-forward`, `bad ref`, `hook declined`, `pre-receive hook declined`,
 * `shallow update not allowed`, `failed to update ref`, `atomic push failure`, `atomic
 * transaction failed`. With side-band, git's `error:` lines explaining a refusal go to the
 * client's progress channel, and keep-alive packets are sent while a received push is checked.
 */

import { isValidRefName, type RefCommand } from "@statewalker/vcs-core";
import {
  getConfig,
  getOutput,
  getRefStore,
  getRepository,
  getState,
  getTransport,
  type ProcessContext,
} from "../../context/context-adapters.js";
import type { RefStore } from "../../context/process-context.js";
import type { ProtocolState } from "../../context/protocol-state.js";
import { encodeFlush, encodePacketLine } from "../../protocol/pkt-line-codec.js";
import type { FsmStateHandler, FsmTransition } from "../types.js";
import { isAncestorOf, PushConnectivity } from "./connectivity.js";
import {
  DEFAULT_MAX_PUSH_COMMANDS,
  DEFAULT_RECEIVE_KEEP_ALIVE_MS,
  type HookVerdict,
  type ReceiveCommand,
  type ReceivePackConfig,
  type ReceivePackHookContext,
  type ReceivePackHooks,
} from "./receive-pack-types.js";
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

  // Read push commands (and shallow lines) from client
  ["READ_COMMANDS", "COMMANDS_RECEIVED", "READ_PUSH_OPTIONS"],
  ["READ_COMMANDS", "NO_COMMANDS", ""], // Client sent nothing
  ["READ_COMMANDS", "ERROR", ""],

  // Read push options (if push-options capability negotiated)
  ["READ_PUSH_OPTIONS", "OPTIONS_RECEIVED", "AUTHORIZE"],
  ["READ_PUSH_OPTIONS", "NO_OPTIONS", "AUTHORIZE"],
  ["READ_PUSH_OPTIONS", "ERROR", ""],

  // Authorize the commands before the pack is read
  ["AUTHORIZE", "AUTHORIZED", "RECEIVE_PACK"],
  ["AUTHORIZE", "DENIED", ""], // whole push refused, `authorizeFailure: "fatal"`
  ["AUTHORIZE", "ERROR", ""],

  // Receive pack file from client
  ["RECEIVE_PACK", "PACK_RECEIVED", "UNPACK"],
  ["RECEIVE_PACK", "EMPTY_PACK", "CHECK_CONNECTIVITY"], // Delete-only
  ["RECEIVE_PACK", "PACK_SKIPPED", "CHECK_CONNECTIVITY"], // Every command needing it refused
  ["RECEIVE_PACK", "ERROR", ""],

  // Unpack and store objects
  ["UNPACK", "UNPACK_OK", "CHECK_CONNECTIVITY"],
  ["UNPACK", "UNPACK_FAILED", "SEND_STATUS"],

  // Check connectivity (every object the new tips need is here) and shallow updates
  ["CHECK_CONNECTIVITY", "CONNECTIVITY_OK", "RUN_PRE_RECEIVE_HOOK"],
  ["CHECK_CONNECTIVITY", "CONNECTIVITY_FAILED", "RUN_PRE_RECEIVE_HOOK"], // per-ref refusals
  ["CHECK_CONNECTIVITY", "INTERNAL_ERROR", "SEND_STATUS"], // reported in band: "internal error"

  // Pre-receive hook
  ["RUN_PRE_RECEIVE_HOOK", "HOOK_OK", "VALIDATE_COMMANDS"],
  ["RUN_PRE_RECEIVE_HOOK", "NO_HOOK", "VALIDATE_COMMANDS"],
  ["RUN_PRE_RECEIVE_HOOK", "HOOK_REJECTED", "SEND_STATUS"],
  ["RUN_PRE_RECEIVE_HOOK", "NOTHING_TO_DO", "SEND_STATUS"],

  // Check each command (git's update()) and run the update hook
  ["VALIDATE_COMMANDS", "ALL_VALID", "APPLY_UPDATES"],
  ["VALIDATE_COMMANDS", "SOME_INVALID", "APPLY_UPDATES"], // Partial execution
  ["VALIDATE_COMMANDS", "ALL_INVALID", "SEND_STATUS"],
  ["VALIDATE_COMMANDS", "INTERNAL_ERROR", "SEND_STATUS"], // reported in band: "internal error"

  // Apply ref updates
  ["APPLY_UPDATES", "UPDATES_APPLIED", "SEND_STATUS"],
  ["APPLY_UPDATES", "PARTIAL_APPLIED", "SEND_STATUS"], // Some failed
  ["APPLY_UPDATES", "ATOMIC_FAILED", "SEND_STATUS"], // Atomic push failed
  ["APPLY_UPDATES", "INTERNAL_ERROR", "SEND_STATUS"], // reported in band: "internal error"

  // Send status report
  ["SEND_STATUS", "STATUS_SENT", "RUN_POST_RECEIVE_HOOK"],
  ["SEND_STATUS", "ERROR", ""],

  // Post-receive hook: started after the report, detached
  ["RUN_POST_RECEIVE_HOOK", "HOOK_STARTED", ""],
  ["RUN_POST_RECEIVE_HOOK", "NO_HOOK", ""],
];

/** The capabilities receive-pack advertises (report-status-v2 is not: decision P3.4). */
export const RECEIVE_PACK_CAPABILITIES: readonly string[] = [
  "report-status",
  "delete-refs",
  "ofs-delta",
  "side-band-64k",
  "atomic",
  "push-options",
  "quiet",
];

const OID = /^[0-9a-f]{40}$/;

/** The reason given for every command when the authorize hook throws (details: the log). */
const AUTHORIZE_FAILED = "authorization failed";

/** git's report-status texts. */
const FAILED_TO_UPDATE = "failed to update ref";
const ATOMIC_TRANSACTION_FAILED = "atomic transaction failed";
const ATOMIC_PUSH_FAILURE = "atomic push failure";

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
        const capabilities = getConfig(ctx).serverCapabilities ?? RECEIVE_PACK_CAPABILITIES;

        let first = true;
        const refsArray = Array.from(refs);

        // Empty repository
        if (refsArray.length === 0) {
          await transport.writeLine(`${ZERO_OID} capabilities^{}\0${capabilities.join(" ")}`);
          await transport.writeFlush();
          // READ_COMMANDS populates state.capabilities with the client's request.
          return "EMPTY_REPO";
        }

        for (const [name, oid] of refsArray) {
          const line = first ? `${oid} ${name}\0${capabilities.join(" ")}` : `${oid} ${name}`;
          await transport.writeLine(line);
          state.refs.set(name, oid);
          first = false;
        }
        await transport.writeFlush();
        return "REFS_SENT";
      } catch (e) {
        output.error = String(e);
        return "ERROR";
      }
    },
  ],

  // Read push commands (and shallow lines) from client
  [
    "READ_COMMANDS",
    async (ctx) => {
      const transport = getTransport(ctx);
      const state = getState<ServerPushState>(ctx);
      const output = getOutput(ctx);
      const maxCommands = receivePackConfig(ctx).maxCommands ?? DEFAULT_MAX_PUSH_COMMANDS;
      try {
        const pushCommands: PushCommand[] = [];
        const shallow: string[] = [];

        while (true) {
          const pkt = await transport.readPktLine();
          if (pkt.type === "flush") break;
          if (pkt.type === "eof") {
            // git's receive-pack ends quietly on a client that sends nothing
            if (pushCommands.length === 0 && shallow.length === 0) break;
            return protocolError(ctx, "protocol error: unexpected end of the commands");
          }
          if (pkt.type === "delim") {
            return protocolError(ctx, "protocol error: unexpected delimiter in the commands");
          }

          let line = pkt.text.endsWith("\n") ? pkt.text.slice(0, -1) : pkt.text;

          if (line.startsWith("shallow ")) {
            const oid = line.slice(8);
            if (!OID.test(oid)) {
              return protocolError(ctx, `protocol error: expected shallow sha, got '${oid}'`);
            }
            shallow.push(oid);
            continue;
          }

          // Capabilities after a NUL (the first command carries them)
          const nul = line.indexOf("\0");
          if (nul >= 0) {
            for (const c of line.slice(nul + 1).split(" ")) {
              if (c) state.capabilities.add(c);
            }
            line = line.slice(0, nul);
          }

          // old-oid SP new-oid SP refname (indexOf, not split with a limit: it truncates)
          const sp1 = line.indexOf(" ");
          const sp2 = sp1 < 0 ? -1 : line.indexOf(" ", sp1 + 1);
          const oldOid = line.slice(0, sp1);
          const newOid = line.slice(sp1 + 1, sp2);
          const refName = line.slice(sp2 + 1);
          if (sp1 < 0 || sp2 < 0 || !OID.test(oldOid) || !OID.test(newOid) || !refName) {
            return protocolError(ctx, `protocol error: expected old/new/ref, got '${line}'`);
          }

          let type: PushCommandType;
          if (newOid === ZERO_OID) {
            type = "DELETE";
          } else if (oldOid === ZERO_OID) {
            type = "CREATE";
          } else {
            type = "UPDATE"; // fast-forward checked later
          }

          pushCommands.push({ oldOid, newOid, refName, type, result: "NOT_ATTEMPTED" });
          if (pushCommands.length > maxCommands) {
            return protocolError(ctx, `protocol error: more than ${maxCommands} commands`);
          }
        }

        state.pushCommands = pushCommands;
        state.pushShallow = shallow;

        if (pushCommands.length === 0) {
          return "NO_COMMANDS";
        }
        return "COMMANDS_RECEIVED";
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
      const maxOptions = receivePackConfig(ctx).maxCommands ?? DEFAULT_MAX_PUSH_COMMANDS;
      try {
        if (!state.capabilities.has("push-options")) {
          return "NO_OPTIONS";
        }

        const pushOptions: string[] = [];

        while (true) {
          const pkt = await transport.readPktLine();
          if (pkt.type === "flush") break;
          if (pkt.type === "eof") {
            return protocolError(ctx, "protocol error: unexpected end of the push options");
          }
          if (pkt.type === "delim") continue;
          pushOptions.push(pkt.text.endsWith("\n") ? pkt.text.slice(0, -1) : pkt.text);
          if (pushOptions.length > maxOptions) {
            return protocolError(ctx, `protocol error: more than ${maxOptions} push options`);
          }
        }

        state.pushOptions = pushOptions;
        return "OPTIONS_RECEIVED";
      } catch (e) {
        output.error = String(e);
        return "ERROR";
      }
    },
  ],

  // Authorize the commands, before the pack is read
  [
    "AUTHORIZE",
    async (ctx) => {
      const state = getState<ServerPushState>(ctx);
      const output = getOutput(ctx);
      const rp = receivePackConfig(ctx);
      try {
        const hook = receivePackHooks(ctx)?.authorize;
        if (hook) {
          const commands = state.pushCommands ?? [];
          let verdict: ReturnType<typeof normalizeVerdict>;
          try {
            verdict = normalizeVerdict(
              await hook(commands.map(toReceiveCommand), hookContext(ctx)),
            );
          } catch (e) {
            // the details go to the server's log, never to the client
            logError(ctx, "authorize hook failed", e);
            if (rp.authorizeFailure === "fatal") {
              output.error = AUTHORIZE_FAILED;
              return "ERROR";
            }
            verdict = { ok: false, message: AUTHORIZE_FAILED };
          }
          if (!verdict.ok) {
            const reason = oneLine(verdict.message ?? "") || "not authorized";
            if (!verdict.rejectedRefs && rp.authorizeFailure === "fatal") {
              output.authorizationDenied = reason;
              output.error = reason;
              return "DENIED";
            }
            const refused = verdict.rejectedRefs ? new Set(verdict.rejectedRefs) : undefined;
            for (const cmd of commands) {
              if (cmd.result === "NOT_ATTEMPTED" && (!refused || refused.has(cmd.refName))) {
                reject(cmd, reason);
              }
            }
          }
        }
        rp.onAuthorized?.();
        return "AUTHORIZED";
      } catch (e) {
        output.error = e instanceof Error ? e.message : String(e);
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
        const commands = state.pushCommands ?? [];
        // No pack for a delete-only push
        if (!commands.some((cmd) => cmd.type !== "DELETE")) {
          return "EMPTY_PACK";
        }
        // Every command needing the pack refused: nothing of it is stored
        if (!commands.some((cmd) => cmd.type !== "DELETE" && cmd.result === "NOT_ATTEMPTED")) {
          const rp = receivePackConfig(ctx);
          if (rp.drainRefusedPack && rp.discardPack) {
            await rp.discardPack();
          } else if (rp.drainRefusedPack) {
            try {
              for await (const _ of transport.readRawPack()) {
                // discarded
              }
            } catch {
              // a broken pack nobody wanted
            }
          }
          return "PACK_SKIPPED";
        }

        // The client sends the raw pack after the pkt-line commands, whatever side-band says
        // (side-band is for the server's answer only).
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
      const state = getState<ServerPushState>(ctx);
      try {
        if (state.packStream) {
          output.packResult = await repository.importPack(state.packStream);
        }
        return "UNPACK_OK";
      } catch (e) {
        // git: "unpack <error>", and every command "unpacker error"
        state.unpackStatus =
          oneLine(e instanceof Error ? e.message : String(e)).slice(0, 200) || "failed";
        for (const cmd of state.pushCommands ?? []) {
          if (cmd.result === "NOT_ATTEMPTED") reject(cmd, "unpacker error");
        }
        return "UNPACK_FAILED";
      }
    },
  ],

  // Check connectivity and shallow updates
  [
    "CHECK_CONNECTIVITY",
    async (ctx) => {
      const repository = getRepository(ctx);
      const state = getState<ServerPushState>(ctx);
      const rp = receivePackConfig(ctx);
      // the pack is read: keep the client's connection alive while the push is checked
      startKeepAlive(ctx);
      try {
        const known = new Set(state.refs.values());
        const pending = () =>
          (state.pushCommands ?? []).filter(
            (c) => c.result === "NOT_ATTEMPTED" && c.type !== "DELETE",
          );

        // The client's shallow commits we now have: a push whose new history ends there
        // would leave the repository with missing parents (git's update_shallow_info)
        const theirs = new Set<string>();
        for (const oid of state.pushShallow ?? []) {
          if (await repository.has(oid)) theirs.add(oid);
        }
        const shallowAllowed = rp.shallowUpdate === true && !!repository.updateShallow;

        const tips = [...new Set(pending().map((c) => c.newOid))];
        if (tips.length === 0) return "CONNECTIVITY_OK";
        // One analysis for the push: the shallow commits are grafts (git's shallow file), each
        // ref's verdict is read off the new history without walking again
        const conn = new PushConnectivity(repository, known, { shallow: theirs });
        await conn.analyze(tips);
        await sendProgress(ctx, `Checking connectivity: ${conn.objects}, done.\n`);
        let failed = false;
        for (const cmd of pending()) {
          const verdict = conn.verdict(cmd.newOid);
          if (verdict.reachesShallow && !shallowAllowed) {
            reject(cmd, "shallow update not allowed");
          } else if (!verdict.ok) {
            cmd.result = "REJECTED_MISSING_OBJECT";
            cmd.message = "missing necessary objects";
            failed = true;
          }
        }
        if (shallowAllowed && theirs.size > 0) state.shallowConnectivity = conn;
        if (!failed) return "CONNECTIVITY_OK";
        return "CONNECTIVITY_FAILED";
      } catch (e) {
        return internalError(ctx, e);
      }
    },
  ],

  // Run pre-receive hook
  [
    "RUN_PRE_RECEIVE_HOOK",
    async (ctx) => {
      const state = getState<ServerPushState>(ctx);
      const commands = state.pushCommands ?? [];
      const open = commands.filter((cmd) => cmd.result === "NOT_ATTEMPTED");
      if (open.length === 0) return "NOTHING_TO_DO";

      const hook = receivePackHooks(ctx)?.preReceive;
      if (!hook) return "NO_HOOK";

      let verdict: ReturnType<typeof normalizeVerdict>;
      try {
        verdict = normalizeVerdict(await hook(open.map(toReceiveCommand), hookContext(ctx)));
      } catch (e) {
        logError(ctx, "pre-receive hook failed", e);
        await sendError(ctx, "pre-receive hook error");
        verdict = { ok: false };
      }
      if (verdict.ok) return "HOOK_OK";

      if (verdict.message) await sendMessage(ctx, verdict.message);
      const refused = verdict.rejectedRefs ? new Set(verdict.rejectedRefs) : undefined;
      for (const cmd of open) {
        if (!refused || refused.has(cmd.refName)) reject(cmd, "pre-receive hook declined");
      }
      return commands.some((c) => c.result === "NOT_ATTEMPTED") ? "HOOK_OK" : "HOOK_REJECTED";
    },
  ],

  // Check each command as git's update() does, then the update hook
  [
    "VALIDATE_COMMANDS",
    async (ctx) => {
      const state = getState<ServerPushState>(ctx);
      try {
        await validateCommands(ctx);
        const commands = state.pushCommands ?? [];
        const invalidCount = commands.filter((c) => c.result !== "NOT_ATTEMPTED").length;
        if (invalidCount === commands.length) return "ALL_INVALID";
        if (invalidCount > 0) return "SOME_INVALID";
        return "ALL_VALID";
      } catch (e) {
        return internalError(ctx, e);
      }
    },
  ],

  // Apply ref updates
  [
    "APPLY_UPDATES",
    async (ctx) => {
      const state = getState<ServerPushState>(ctx);
      const refStore = getRefStore(ctx);
      const repository = getRepository(ctx);
      try {
        const atomic = state.capabilities.has("atomic");
        // An accepted shallow push records the client's boundary before its refs move: only
        // the shallow commits the new history of the refs still accepted ends at (git's
        // delayed_reachability_test), not those the existing refs already reach
        if (state.shallowConnectivity && repository.updateShallow) {
          const all = state.pushCommands ?? [];
          const blocked = atomic && all.some((c) => c.result !== "NOT_ATTEMPTED");
          const tips = all
            .filter((c) => c.result === "NOT_ATTEMPTED" && c.type !== "DELETE")
            .map((c) => c.newOid);
          const reached = blocked ? [] : state.shallowConnectivity.shallowReachedFrom(tips);
          if (reached.length > 0) await repository.updateShallow(reached);
        }
        return await applyUpdates(state, refStore, atomic);
      } catch (e) {
        return internalError(ctx, e);
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
      stopKeepAlive(ctx);
      try {
        await state.bandQueue;
        const useSideband = state.capabilities.has("side-band-64k");
        if (state.capabilities.has("report-status")) {
          const lines = [`unpack ${state.unpackStatus ?? "ok"}`];
          for (const cmd of state.pushCommands ?? []) {
            lines.push(
              cmd.result === "OK"
                ? `ok ${cmd.refName}`
                : `ng ${cmd.refName} ${oneLine(cmd.message ?? "") || "rejected"}`,
            );
          }
          if (useSideband) {
            // The report is a pkt-line stream inside channel 1
            for (const line of lines) {
              await transport.writeSideband(1, encodePacketLine(`${line}\n`));
            }
            await transport.writeSideband(1, encodeFlush());
          } else {
            for (const line of lines) await transport.writeLine(line);
            await transport.writeFlush();
          }
        }
        // git ends a side-band answer with a flush, report or not
        if (useSideband) await transport.writeFlush();
        state.reportSent = true;
        return "STATUS_SENT";
      } catch (e) {
        output.error = String(e);
        return "ERROR";
      }
    },
  ],

  // Start the post-receive hook, detached, once the report is out
  [
    "RUN_POST_RECEIVE_HOOK",
    async (ctx) => {
      const state = getState<ServerPushState>(ctx);
      const hook = receivePackHooks(ctx)?.postReceive;
      const applied = (state.appliedCommands ?? []).map(toReceiveCommand);
      if (!hook || applied.length === 0) return "NO_HOOK";
      const hookCtx = hookContext(ctx);
      const task = async () => {
        try {
          await hook(applied, hookCtx);
        } catch (e) {
          logError(ctx, "post-receive hook failed", e);
        }
      };
      const afterReport = receivePackConfig(ctx).afterReport;
      if (afterReport) afterReport(task);
      else setTimeout(() => void task(), 0);
      return "HOOK_STARTED";
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
  /** The client's `shallow` lines */
  pushShallow?: string[];
  /** The connectivity analysis of an accepted shallow push (which shallow commits to record) */
  shallowConnectivity?: PushConnectivity;
  /** The unpack status when not "ok" */
  unpackStatus?: string;
  /** Side-band writes besides the FSM's own (keep-alive, messages), in order */
  bandQueue?: Promise<void>;
  keepAliveTimer?: ReturnType<typeof setInterval>;
  hookContext?: ReceivePackHookContext;
  reportSent?: boolean;
}

/** Context with hooks set directly (older callers). */
interface ContextWithHooks extends ProcessContext {
  hooks?: ReceivePackHooks;
}

function receivePackConfig(ctx: ProcessContext): ReceivePackConfig {
  return getConfig(ctx).receivePack ?? {};
}

function receivePackHooks(ctx: ProcessContext): ReceivePackHooks | undefined {
  return receivePackConfig(ctx).hooks ?? (ctx as ContextWithHooks).hooks;
}

function protocolError(ctx: ProcessContext, message: string): string {
  const output = getOutput(ctx);
  output.error = message;
  output.protocolError = true;
  return "ERROR";
}

/**
 * A failure of the server after the pack was read: the commands not decided yet are refused
 * "internal error" in the report (the client hears about it), and `output.error` tells the
 * driver.
 */
function internalError(ctx: ProcessContext, error: unknown): string {
  const output = getOutput(ctx);
  output.error = error instanceof Error ? error.message : String(error);
  logError(ctx, "receive-pack failed", error);
  for (const cmd of getState<ServerPushState>(ctx).pushCommands ?? []) {
    if (cmd.result === "NOT_ATTEMPTED") reject(cmd, "internal error");
  }
  return "INTERNAL_ERROR";
}

function reject(cmd: PushCommand, message: string): void {
  cmd.result = "REJECTED_OTHER_REASON";
  cmd.message = message;
}

/** One report line per command: never a line break inside (hook messages are free text). */
function oneLine(text: string): string {
  return text.replace(/[\r\n]+/g, " ").trim();
}

function toReceiveCommand(cmd: PushCommand): ReceiveCommand {
  return { refName: cmd.refName, oldOid: cmd.oldOid, newOid: cmd.newOid, type: cmd.type };
}

function normalizeVerdict(verdict: HookVerdict): {
  ok: boolean;
  message?: string;
  rejectedRefs?: string[];
} {
  if (verdict === undefined || verdict === true) return { ok: true };
  if (verdict === false) return { ok: false };
  if (typeof verdict === "string") return { ok: false, message: verdict };
  return verdict;
}

function hookContext(ctx: ProcessContext): ReceivePackHookContext {
  const state = getState<ServerPushState>(ctx);
  if (!state.hookContext) {
    const rp = receivePackConfig(ctx);
    state.hookContext = {
      capabilities: state.capabilities,
      get pushOptions() {
        return state.pushOptions ?? [];
      },
      get shallow() {
        return state.pushShallow ?? [];
      },
      request: rp.request,
      repoPath: rp.repoPath,
      message: (text: string) => sendMessage(ctx, text),
    };
  }
  return state.hookContext;
}

function logError(ctx: ProcessContext, message: string, error: unknown): void {
  const logger = receivePackConfig(ctx).logger;
  if (logger) logger.error(message, error);
  else console.error(message, error);
}

/** Queues a side-band write after the earlier ones (keep-alive and messages interleave). */
function enqueueBand(ctx: ProcessContext, write: () => Promise<void>): Promise<void> {
  const state = getState<ServerPushState>(ctx);
  const next = (state.bandQueue ?? Promise.resolve()).then(write).catch(() => {
    // the client is gone: the report write will tell
  });
  state.bandQueue = next;
  return next;
}

/** Writes `text` on the progress channel (side-band only; nothing once the report is out). */
function sendMessage(ctx: ProcessContext, text: string): Promise<void> {
  const state = getState<ServerPushState>(ctx);
  if (!state.capabilities.has("side-band-64k") || state.reportSent || !text) {
    return Promise.resolve();
  }
  const transport = getTransport(ctx);
  const bytes = new TextEncoder().encode(text.endsWith("\n") ? text : `${text}\n`);
  return enqueueBand(ctx, () => transport.writeSideband(2, bytes));
}

/** Progress text: not sent to a `quiet` client. */
function sendProgress(ctx: ProcessContext, text: string): Promise<void> {
  if (getState(ctx).capabilities.has("quiet")) return Promise.resolve();
  return sendMessage(ctx, text);
}

/** git's `rp_error`: an `error:` line on the progress channel, quiet or not. */
function sendError(ctx: ProcessContext, text: string): Promise<void> {
  return sendMessage(ctx, `error: ${text}`);
}

/** Starts side-band keep-alive packets (`0005\1`, an empty channel-1 packet), as git does. */
function startKeepAlive(ctx: ProcessContext): void {
  const state = getState<ServerPushState>(ctx);
  const ms = receivePackConfig(ctx).keepAliveMs ?? DEFAULT_RECEIVE_KEEP_ALIVE_MS;
  if (state.keepAliveTimer || ms <= 0 || !state.capabilities.has("side-band-64k")) return;
  const transport = getTransport(ctx);
  const keepAlive = new Uint8Array([1]);
  state.keepAliveTimer = setInterval(() => {
    void enqueueBand(ctx, () => transport.writePktLine(keepAlive));
  }, ms);
  (state.keepAliveTimer as { unref?: () => void }).unref?.();
}

function stopKeepAlive(ctx: ProcessContext): void {
  const state = getState<ServerPushState>(ctx);
  if (state.keepAliveTimer) {
    clearInterval(state.keepAliveTimer);
    state.keepAliveTimer = undefined;
  }
}

/** The object's type, as far as the facade tells (undefined: absent or unknown). */
async function objectType(ctx: ProcessContext, oid: string): Promise<string | undefined> {
  const repository = getRepository(ctx);
  if (repository.getObjectType) return repository.getObjectType(oid);
  if (repository.getCommitInfo) {
    if (await repository.getCommitInfo(oid)) return "commit";
    return (await repository.has(oid)) ? "other" : undefined;
  }
  return (await repository.has(oid)) ? "unknown" : undefined;
}

/** The checks of git's `update()`, per command, then the update hook. */
async function validateCommands(ctx: ProcessContext): Promise<void> {
  const state = getState<ServerPushState>(ctx);
  const config = getConfig(ctx);
  const rp = receivePackConfig(ctx);
  const repository = getRepository(ctx);
  const refStore = getRefStore(ctx);
  const commands = state.pushCommands ?? [];
  const atomic = state.capabilities.has("atomic");

  // bareness: the option, else a caller naming the checked-out branch means a working tree
  // (its protection is never dropped silently), else the facade, else bare
  const bare =
    rp.bare ??
    (config.currentBranch !== undefined
      ? false
      : repository.isBare
        ? await repository.isBare()
        : true);
  const head = config.currentBranch ?? (await refStore.getSymrefTarget?.("HEAD"));
  const denyCurrentBranch = config.denyCurrentBranch ?? true;
  const denyDeleteCurrent = rp.denyDeleteCurrent ?? true;

  // The same ref twice: git's ref transaction refuses ("multiple updates for ref")
  const seen = new Set<string>();
  for (const cmd of commands) {
    if (!seen.has(cmd.refName)) {
      seen.add(cmd.refName);
      continue;
    }
    await sendError(ctx, `multiple updates for ref '${cmd.refName}' not allowed`);
    if (atomic) {
      for (const c of commands) {
        if (c.result === "NOT_ATTEMPTED") {
          c.result = "ATOMIC_REJECTED";
          c.message = ATOMIC_TRANSACTION_FAILED;
        }
      }
      return;
    }
    if (cmd.result === "NOT_ATTEMPTED") {
      cmd.result = "LOCK_FAILURE";
      cmd.message = FAILED_TO_UPDATE;
    }
  }

  const hook = receivePackHooks(ctx)?.update;
  for (const cmd of commands) {
    if (cmd.result !== "NOT_ATTEMPTED") continue;
    const name = cmd.refName;
    const isDelete = cmd.type === "DELETE";

    // only valid names under refs/ (one level allowed for a delete), never HEAD itself
    if (!name.startsWith("refs/") || !isValidRefName(name.slice(5), { allowOneLevel: isDelete })) {
      await sendError(ctx, `refusing to update funny ref '${name}' remotely`);
      reject(cmd, "funny refname");
      continue;
    }

    if (!bare && denyCurrentBranch && head === name) {
      await sendError(ctx, `refusing to update checked out branch: ${name}`);
      cmd.result = "REJECTED_CURRENT_BRANCH";
      cmd.message = "branch is currently checked out";
      continue;
    }

    // git deletes an existing ref even when the client sent the zero id as its old value
    // ("allowing deletion of corrupt ref"); the deletion rules still apply here
    const existing = state.refs.get(name);
    if (isDelete && cmd.oldOid === ZERO_OID && existing !== undefined) {
      cmd.expectedOid = existing;
    }
    if (isDelete && (cmd.oldOid !== ZERO_OID || existing !== undefined)) {
      if (config.allowDeletes === false && name.startsWith("refs/heads/")) {
        await sendError(ctx, `denying ref deletion for ${name}`);
        cmd.result = "REJECTED_NODELETE";
        cmd.message = "deletion prohibited";
        continue;
      }
      if (denyDeleteCurrent && head === name) {
        await sendError(ctx, `refusing to delete the current branch: ${name}`);
        cmd.result = "REJECTED_NODELETE";
        cmd.message = "deletion of the current branch prohibited";
        continue;
      }
    }

    if (cmd.expectedOid !== undefined) {
      await sendMessage(ctx, "warning: allowing deletion of corrupt ref");
    }

    // the old value the client saw (git's ref transaction checks it)
    const current = existing ?? ZERO_OID;
    if (cmd.oldOid !== current && !(isDelete && cmd.oldOid === ZERO_OID)) {
      await sendError(
        ctx,
        current === ZERO_OID
          ? `cannot lock ref '${name}': unable to resolve reference '${name}'`
          : cmd.oldOid === ZERO_OID
            ? `cannot lock ref '${name}': reference already exists`
            : `cannot lock ref '${name}': is at ${current} but expected ${cmd.oldOid}`,
      );
      cmd.result = "LOCK_FAILURE";
      cmd.message = FAILED_TO_UPDATE;
      continue;
    }

    if (!isDelete) {
      const type = await objectType(ctx, cmd.newOid);
      if (type === undefined) {
        // connectivity found it (a facade without the object walk): git's "bad pack"
        await sendError(ctx, `unpack should have generated ${cmd.newOid}, but I can't find it!`);
        cmd.result = "REJECTED_MISSING_OBJECT";
        cmd.message = "bad pack";
        continue;
      }
      // a branch points at a commit (git's ref backend refuses anything else)
      if (name.startsWith("refs/heads/") && type !== "commit" && type !== "unknown") {
        await sendError(
          ctx,
          `cannot update ref '${name}': trying to write non-commit object ${cmd.newOid} to branch '${name}'`,
        );
        cmd.result = "LOCK_FAILURE";
        cmd.message = FAILED_TO_UPDATE;
        continue;
      }
    }

    if (cmd.type === "UPDATE" && name.startsWith("refs/heads/")) {
      const oldType = await objectType(ctx, cmd.oldOid);
      if (oldType !== "commit" && oldType !== "unknown") {
        await sendError(ctx, `bad sha1 objects for ${name}`);
        reject(cmd, "bad ref");
        continue;
      }
      if (!(await isAncestor(ctx, cmd.oldOid, cmd.newOid))) {
        if (!config.allowNonFastForward) {
          await sendError(ctx, `denying non-fast-forward ${name} (you should pull first)`);
          cmd.result = "REJECTED_NONFASTFORWARD";
          cmd.message = "non-fast-forward";
          continue;
        }
        cmd.type = "UPDATE_NONFASTFORWARD";
      }
    }

    if (hook) {
      let verdict: ReturnType<typeof normalizeVerdict>;
      try {
        verdict = normalizeVerdict(await hook(name, cmd.oldOid, cmd.newOid, hookContext(ctx)));
      } catch (e) {
        logError(ctx, `update hook failed for ${name}`, e);
        await sendError(ctx, "update hook error");
        verdict = { ok: false };
      }
      if (!verdict.ok) {
        if (verdict.message) await sendMessage(ctx, verdict.message);
        await sendError(ctx, `hook declined to update ${name}`);
        reject(cmd, "hook declined");
      }
    }
  }
}

/** Whether `ancestor` is reachable from `oid` through parents. */
function isAncestor(ctx: ProcessContext, ancestor: string, oid: string): Promise<boolean> {
  return isAncestorOf(getRepository(ctx), ancestor, oid);
}

/** A delete of a ref that does not exist: nothing to do, reported ok (git warns). */
function isNoop(cmd: PushCommand): boolean {
  return cmd.oldOid === ZERO_OID && cmd.newOid === ZERO_OID && cmd.expectedOid === undefined;
}

/** The batch command for a push command; git's zero id means "absent" on both sides. */
function toRefCommand(cmd: PushCommand): RefCommand {
  return {
    name: cmd.refName,
    old: cmd.expectedOid ?? (cmd.oldOid === ZERO_OID ? null : cmd.oldOid),
    new: cmd.newOid === ZERO_OID ? null : cmd.newOid,
    noDeref: true, // receive-pack names refs directly, as git does
  };
}

type ApplyResult = "UPDATES_APPLIED" | "PARTIAL_APPLIED" | "ATOMIC_FAILED";

/**
 * Apply the push commands still `NOT_ATTEMPTED`, as git's receive-pack does in
 * a ref transaction.
 *
 * - An atomic push with a command already rejected (validation, hook) changes
 *   nothing: the others get "atomic push failure".
 * - With `refStore.batch`, an atomic push is one batch (all refs or none, every
 *   command "atomic transaction failed" when refused) and a plain push one batch
 *   per ref ("failed to update ref"). Each update checks the old id the client
 *   sent. A store whose batch answers `unsupported` (not atomic for several refs)
 *   gets the one-by-one path.
 * - Without `batch`, refs are written one by one with `update`.
 * - Deleting a ref that does not exist is a no-op reported ok, as git does; it is not
 *   among the applied commands (post-receive does not see it).
 */
async function applyUpdates(
  state: ServerPushState,
  refStore: RefStore,
  atomic: boolean,
): Promise<ApplyResult> {
  const all = state.pushCommands ?? [];
  const open = all.filter((c) => c.result === "NOT_ATTEMPTED");
  state.appliedCommands = [];
  if (atomic && open.length < all.length) {
    for (const c of open) {
      c.result = "ATOMIC_REJECTED";
      c.message = ATOMIC_PUSH_FAILURE;
    }
    return "ATOMIC_FAILED";
  }
  for (const c of open) if (isNoop(c)) c.result = "OK";
  const pending = open.filter((c) => !isNoop(c));
  const okCount = () => all.filter((c) => c.result === "OK").length;

  const batch = refStore.batch?.bind(refStore);
  if (!batch) return applyOneByOne(state, refStore, atomic, pending);
  const options = { message: "push" };

  if (atomic) {
    if (pending.length === 0) return "UPDATES_APPLIED";
    let result: Awaited<ReturnType<typeof batch>>;
    try {
      result = await batch(pending.map(toRefCommand), options);
    } catch {
      result = { ok: false, rejected: pending.map((c) => ({ name: c.refName, reason: "locked" })) };
    }
    if (result.ok) {
      for (const c of pending) c.result = "OK";
      state.appliedCommands = [...pending];
      return "UPDATES_APPLIED";
    }
    if (result.rejected.every((r) => r.reason === "unsupported")) {
      return applyOneByOne(state, refStore, atomic, pending);
    }
    for (const c of all) {
      c.result = "ATOMIC_REJECTED";
      c.message = ATOMIC_TRANSACTION_FAILED;
    }
    return "ATOMIC_FAILED";
  }

  for (const c of pending) {
    let ok = false;
    try {
      ok = (await batch([toRefCommand(c)], options)).ok;
    } catch {
      ok = false;
    }
    if (ok) {
      c.result = "OK";
      state.appliedCommands.push(c);
    } else {
      c.result = "LOCK_FAILURE";
      c.message = FAILED_TO_UPDATE;
    }
  }
  return okCount() === all.length ? "UPDATES_APPLIED" : "PARTIAL_APPLIED";
}

/**
 * Write refs one by one with `update`, for stores without an atomic batch. An
 * atomic push is rolled back best effort when a write fails.
 */
async function applyOneByOne(
  state: ServerPushState,
  refStore: RefStore,
  atomic: boolean,
  pending: PushCommand[],
): Promise<ApplyResult> {
  const all = state.pushCommands ?? [];
  const appliedCommands: PushCommand[] = [];

  for (const cmd of pending) {
    try {
      await refStore.update(cmd.refName, cmd.type === "DELETE" ? ZERO_OID : cmd.newOid);
      cmd.result = "OK";
      appliedCommands.push(cmd);
    } catch (e) {
      cmd.result = "LOCK_FAILURE";
      cmd.message = e instanceof Error ? oneLine(e.message) || FAILED_TO_UPDATE : FAILED_TO_UPDATE;

      if (atomic) {
        // Rollback applied updates (best effort; stores with `batch` need none)
        for (const applied of appliedCommands) {
          try {
            await refStore.update(applied.refName, applied.oldOid);
          } catch {
            // Rollback failed, continue
          }
        }
        for (const other of all) {
          other.result = "ATOMIC_REJECTED";
          other.message = ATOMIC_TRANSACTION_FAILED;
        }
        state.appliedCommands = [];
        return "ATOMIC_FAILED";
      }
    }
  }

  state.appliedCommands = appliedCommands;
  return all.every((c) => c.result === "OK") ? "UPDATES_APPLIED" : "PARTIAL_APPLIED";
}
