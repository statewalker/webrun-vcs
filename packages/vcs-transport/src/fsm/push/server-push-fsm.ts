/**
 * Server Push FSM for git-receive-pack operations, as git's `builtin/receive-pack.c`.
 *
 * 1. Send the advertisement (refs + capabilities)
 * 2. Read the commands (and the client's `shallow` lines), then the push options
 * 3. Authorize the commands (the `authorize` hook), before any pack byte is read
 * 4. Receive and import the pack (unless every command needing it is refused, or a delete)
 *    into a quarantine (git's `tmp_objdir`), where the repository can keep one
 * 5. Check connectivity (git's `check_connected`) and shallow updates
 * 6. Run the pre-receive hook
 * 7. Check each command as git's `update()` does (ref name, current branch, deletes,
 *    fast-forward, branch tips are commits, duplicates), then the per-ref update hook
 * 8. Publish the quarantined objects, then apply the ref updates (one transaction when atomic)
 * 9. Send the status report, then start the post-receive hook (detached)
 *
 * Quarantine: steps 5 to 7 read the pushed objects through the quarantine's view
 * (`RepositoryQuarantine.repository`, also given to hooks as `repository`); nobody else sees
 * them. They are published (`commit`) only when at least one ref update is still to be applied,
 * before any ref moves, as git migrates the objects and then updates the refs. A push refused
 * as a whole (unpack error, connectivity, authorize, pre-receive or update refusals of every
 * ref, an atomic push with a refused ref, an internal error, a client gone mid-pack) leaves no
 * object behind: the quarantine is discarded. Drivers call `releaseReceivePack` once the FSM
 * stops, so a run that ends on an error discards it too.
 *
 * The report texts are git's: `unpacker error`, `missing necessary objects`, `funny refname`,
 * `branch is currently checked out`, `deletion prohibited`, `deletion of the current branch
 * prohibited`, `non-fast-forward`, `bad ref`, `hook declined`, `pre-receive hook declined`,
 * `shallow update not allowed`, `failed to update ref`, `invalid new value provided`, `atomic push failure`, `atomic
 * transaction failed`. With side-band, git's `error:` lines explaining a refusal go to the
 * client's progress channel, and keep-alive packets are sent while a received push is checked.
 */

import { isValidRefName, type RefCommand } from "@statewalker/vcs-core";
import type { RepositoryFacade, RepositoryQuarantine } from "../../api/repository-facade.js";
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
import { isRefHidden, receivePackRefs } from "../../protocol/hidden-refs.js";
import { encodeFlush, encodePacketLine } from "../../protocol/pkt-line-codec.js";
import type { FsmStateHandler, FsmTransition } from "../types.js";
import { isAncestorOf, PushConnectivity } from "./connectivity.js";
import {
  DEFAULT_MAX_PUSH_COMMANDS,
  DEFAULT_RECEIVE_KEEP_ALIVE_MS,
  type HookVerdict,
  type ReceiveCommand,
  type ReceiveDenyAction,
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
  ["RUN_PRE_RECEIVE_HOOK", "DIED", ""], // receive-pack died looking the hook up (ReceivePackDiedError)

  // Check each command (git's update()) and run the update hook
  ["VALIDATE_COMMANDS", "ALL_VALID", "APPLY_UPDATES"],
  ["VALIDATE_COMMANDS", "SOME_INVALID", "APPLY_UPDATES"], // Partial execution
  ["VALIDATE_COMMANDS", "ALL_INVALID", "SEND_STATUS"],
  ["VALIDATE_COMMANDS", "INTERNAL_ERROR", "SEND_STATUS"], // reported in band: "internal error"
  ["VALIDATE_COMMANDS", "DIED", ""], // the ref store's reference-transaction hook aborted

  // Apply ref updates
  ["APPLY_UPDATES", "UPDATES_APPLIED", "SEND_STATUS"],
  ["APPLY_UPDATES", "PARTIAL_APPLIED", "SEND_STATUS"], // Some failed
  ["APPLY_UPDATES", "ATOMIC_FAILED", "SEND_STATUS"], // Atomic push failed
  ["APPLY_UPDATES", "INTERNAL_ERROR", "SEND_STATUS"], // reported in band: "internal error"
  ["APPLY_UPDATES", "DIED", ""], // the ref store's reference-transaction hook aborted: git dies

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
/** git's ref_transaction_error_msg(REF_TRANSACTION_ERROR_INVALID_NEW_VALUE) */
const INVALID_NEW_VALUE = "invalid new value provided";
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
        // the refs under refs/ but the hidden ones (git's receive.hideRefs): never HEAD
        const refsArray = receivePackRefs(refs, getConfig(ctx).hiddenRefs);
        // write_head_info: then the alternates' refs as `.have`, each object id once and none
        // an advertised ref names (the first line carries the capabilities, whichever it is)
        const seen = new Set(refsArray.map(([, oid]) => oid));
        const haves: string[] = [];
        for (const oid of (await getRepository(ctx).alternateRefs?.()) ?? []) {
          if (seen.has(oid)) continue;
          seen.add(oid);
          haves.push(oid);
        }

        // Empty repository
        if (refsArray.length === 0 && haves.length === 0) {
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
        for (const oid of haves) {
          await transport.writeLine(
            first ? `${oid} .have\0${capabilities.join(" ")}` : `${oid} .have`,
          );
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
              await timedHook(ctx, "authorize", () =>
                hook(commands.map(toReceiveCommand), hookContext(ctx)),
              ),
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
          // kept aside until the push is accepted (when the repository can quarantine)
          const { quarantine, ...result } = await repository.importPack(state.packStream, {
            quarantine: true,
          });
          state.quarantine = quarantine;
          output.packResult = result;
          if (!quarantine) warnNoQuarantine(ctx, repository);
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
      // the pushed objects are read through the quarantine
      const repository = pushView(ctx);
      const state = getState<ServerPushState>(ctx);
      const rp = receivePackConfig(ctx);
      // the pack is read: keep the client's connection alive while the push is checked
      startKeepAlive(ctx);
      try {
        const known = new Set(state.refs.values());
        // git's check_connected walks `--not --exclude-hidden=receive --all`: HEAD too, which
        // receive-pack does not advertise (a detached HEAD's history counts as present)
        if (!isRefHidden("HEAD", getConfig(ctx).hiddenRefs)) {
          const head = await getRefStore(ctx).get("HEAD");
          if (head) known.add(head);
        }
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
        const shallowAllowed = rp.shallowUpdate === true && !!getRepository(ctx).updateShallow;

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
      // git's reject_updates_to_hidden: after the connectivity check, before pre-receive
      rejectHiddenUpdates(ctx, commands);
      const open = commands.filter((cmd) => cmd.result === "NOT_ATTEMPTED");
      // git's run_receive_hook with skip_broken=0: every command, refused ones included
      const fed = receivePackConfig(ctx).preReceiveSeesRefused ? commands : open;
      if (fed.length === 0) return "NOTHING_TO_DO";

      const hook = receivePackHooks(ctx)?.preReceive;
      if (!hook) return open.length === 0 ? "NOTHING_TO_DO" : "NO_HOOK";

      let verdict: ReturnType<typeof normalizeVerdict>;
      try {
        verdict = normalizeVerdict(
          await timedHook(ctx, "pre-receive", () =>
            hook(fed.map(toReceiveCommand), hookContext(ctx)),
          ),
        );
      } catch (e) {
        if (isReceivePackDeath(e)) {
          // git dies (a broken hook.* configuration): no status report, the quarantined
          // objects dropped, its message on its stderr
          await discardQuarantine(ctx);
          getOutput(ctx).error = `fatal: ${(e as Error).message}`;
          return "DIED";
        }
        logError(ctx, "pre-receive hook failed", e);
        await sendError(ctx, "pre-receive hook error");
        verdict = { ok: false };
      }
      if (open.length === 0) {
        if (!verdict.ok && verdict.message) await sendMessage(ctx, verdict.message);
        return "NOTHING_TO_DO";
      }
      if (verdict.ok) return "HOOK_OK";

      if (verdict.message) await sendMessage(ctx, verdict.message);
      const refused = verdict.rejectedRefs ? new Set(verdict.rejectedRefs) : undefined;
      for (const cmd of open) {
        if (!refused || refused.has(cmd.refName)) {
          reject(cmd, "pre-receive hook declined");
          // a refusal of some refs only is ours (git's pre-receive refuses the whole push):
          // an atomic push treats it as git's update hook, failing the others
          if (refused) {
            state.preReceiveRefused = state.preReceiveRefused ?? new Set();
            state.preReceiveRefused.add(cmd);
          }
        }
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
        // what was refused before the ref transaction (git's error_string set before
        // execute_commands_atomic): an atomic push still applies the rest, as git
        state.refusedBeforeTransaction = new Set(
          (state.pushCommands ?? []).filter(
            (c) => c.result !== "NOT_ATTEMPTED" && !state.preReceiveRefused?.has(c),
          ),
        );
        // git migrates the quarantined objects once pre-receive passed and a command is still
        // open, before update() checks each (execute_commands): a refusal there keeps them
        if (
          receivePackConfig(ctx).publishBeforeUpdate &&
          (state.pushCommands ?? []).some((c) => c.result === "NOT_ATTEMPTED")
        ) {
          await publishQuarantine(ctx);
        }
        try {
          await validateCommands(ctx);
        } catch (e) {
          if (isTransactionAborted(e) || isReceivePackDeath(e)) {
            getOutput(ctx).error = `fatal: ${(e as Error).message}`;
            return "DIED";
          }
          throw e;
        }
        if (state.peerGone !== undefined) {
          await discardQuarantine(ctx);
          return internalError(ctx, state.peerGone);
        }
        const commands = state.pushCommands ?? [];
        const invalidCount = commands.filter((c) => c.result !== "NOT_ATTEMPTED").length;
        if (invalidCount === commands.length) {
          // git 2.5x still commits the (empty) transaction of each phase update() took up
          const rp = receivePackConfig(ctx);
          if (rp.batchNonAtomic && !state.capabilities.has("atomic") && !state.phasesApplied) {
            try {
              await applyUpdates(state, getRefStore(ctx), false, false, true);
            } catch (e) {
              if (isTransactionAborted(e)) {
                getOutput(ctx).error = `fatal: ${(e as Error).message}`;
                return "DIED";
              }
              throw e;
            }
          }
          return "ALL_INVALID";
        }
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
        // a client that went away mid-check gets no ref update (git dies on the failed write)
        if (state.peerGone !== undefined) {
          await discardQuarantine(ctx);
          return internalError(ctx, state.peerGone);
        }
        const atomic = state.capabilities.has("atomic");
        const all = state.pushCommands ?? [];
        // git migrates the quarantined objects, then updates the refs: published only when a
        // ref update is still to be applied (an atomic push that fails applies none)
        const blocked = atomic && atomicBlocked(ctx, state);
        const applying = all.some((c) => c.result === "NOT_ATTEMPTED") && !blocked;
        if (applying) await publishQuarantine(ctx);
        else await discardQuarantine(ctx);
        // An accepted shallow push records the client's boundary before its refs move: only
        // the shallow commits the new history of the refs still accepted ends at (git's
        // delayed_reachability_test), not those the existing refs already reach
        if (state.shallowConnectivity && repository.updateShallow) {
          const tips = all
            .filter((c) => c.result === "NOT_ATTEMPTED" && c.type !== "DELETE")
            .map((c) => c.newOid);
          const reached = blocked ? [] : state.shallowConnectivity.shallowReachedFrom(tips);
          if (reached.length > 0) await repository.updateShallow(reached);
        }
        return await applyUpdates(
          state,
          refStore,
          atomic,
          blocked,
          receivePackConfig(ctx).batchNonAtomic === true,
        );
      } catch (e) {
        if (isTransactionAborted(e)) {
          // refs.c dies when the reference-transaction hook aborts: receive-pack ends
          // without a status report, its message on its stderr
          const output = getOutput(ctx);
          output.error = `fatal: ${(e as Error).message}`;
          return "DIED";
        }
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
        // a push that got here without applying its refs leaves no object behind
        await discardQuarantine(ctx);
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
        // git ends a side-band answer with a flush, report or not (after post-receive when
        // its output is relayed)
        if (useSideband) {
          if (receivePackConfig(ctx).relayPostReceive) state.flushAfterPostReceive = true;
          else await transport.writeFlush();
        }
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
      if (!hook || applied.length === 0) {
        await closeRelayedBand(ctx);
        return "NO_HOOK";
      }
      const hookCtx = hookContext(ctx);
      const task = async () => {
        try {
          await hook(applied, hookCtx);
        } catch (e) {
          logError(ctx, "post-receive hook failed", e);
        }
      };
      if (receivePackConfig(ctx).relayPostReceive) {
        await task();
        await state.bandQueue;
        await closeRelayedBand(ctx);
        return "HOOK_STARTED";
      }
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
  /** The side-band's closing flush waits for a relayed post-receive */
  flushAfterPostReceive?: boolean;
  pushCommands?: PushCommand[];
  pushOptions?: string[];
  packStream?: AsyncIterable<Uint8Array>;
  appliedCommands?: PushCommand[];
  /** The commands `interleaveUpdateHook` or `batchNonAtomic` applied while checking them */
  eagerlyApplied?: PushCommand[];
  /** `batchNonAtomic` applied each phase's commands as it checked them (no batch is left) */
  phasesApplied?: boolean;
  /** The client's `shallow` lines */
  pushShallow?: string[];
  /** The connectivity analysis of an accepted shallow push (which shallow commits to record) */
  shallowConnectivity?: PushConnectivity;
  /**
   * The commands refused before the ref transaction (connectivity, shallow, authorize,
   * pre-receive): an atomic push applies the others (git), unless `strictAtomic`
   */
  refusedBeforeTransaction?: Set<PushCommand>;
  /**
   * The commands a `preReceive` verdict with `rejectedRefs` refused: an atomic push treats
   * them as refused by the update hook (the others get "atomic push failure")
   */
  preReceiveRefused?: Set<PushCommand>;
  /** The unpack status when not "ok" */
  unpackStatus?: string;
  /** The received objects, kept aside until the push is accepted (git's tmp_objdir) */
  quarantine?: RepositoryQuarantine;
  /** Side-band writes besides the FSM's own (keep-alive, messages), in order */
  bandQueue?: Promise<void>;
  keepAliveTimer?: ReturnType<typeof setInterval>;
  /** A side-band write failed (the client went away or stopped reading): set to its error */
  peerGone?: unknown;
  hookContext?: ReceivePackHookContext;
  reportSent?: boolean;
}

/** Context with hooks set directly (older callers). */
interface ContextWithHooks extends ProcessContext {
  hooks?: ReceivePackHooks;
}

/**
 * The repository as the push sees it: the quarantine's view (the pushed objects, then the
 * repository's) while there is one, else the repository.
 */
function pushView(ctx: ProcessContext): RepositoryFacade {
  return getState<ServerPushState>(ctx).quarantine?.repository ?? getRepository(ctx);
}

/** Publishes the quarantined objects into the repository (git's tmp_objdir_migrate). */
async function publishQuarantine(ctx: ProcessContext): Promise<void> {
  const state = getState<ServerPushState>(ctx);
  const quarantine = state.quarantine;
  if (!quarantine) return;
  state.quarantine = undefined;
  try {
    await quarantine.commit();
  } catch (e) {
    // whatever commit could not publish is not left behind (commit cleans up after itself
    // in our backends; a facade's own quarantine may not)
    await quarantine.discard().catch(() => {});
    throw e;
  }
}

/** Repositories already warned about (once each, per process). */
const warnedNoQuarantine = new WeakSet<object>();

/**
 * A push imported without a quarantine (the facade ignores `quarantine: true`, or its store
 * cannot keep objects aside): its objects are visible at once and stay if it is refused. Said
 * once per repository facade through the logger's `warn` (else `console.warn`).
 */
function warnNoQuarantine(ctx: ProcessContext, repository: object): void {
  if (warnedNoQuarantine.has(repository)) return;
  warnedNoQuarantine.add(repository);
  const message =
    "receive-pack: this repository cannot quarantine received packs; the objects of a refused push stay in its store";
  const logger = receivePackConfig(ctx).logger;
  if (logger?.warn) logger.warn(message);
  else console.warn(message);
}

/** Removes the quarantined objects of a push that will not apply them. */
async function discardQuarantine(ctx: ProcessContext): Promise<void> {
  const state = getState<ServerPushState>(ctx);
  const quarantine = state.quarantine;
  if (!quarantine) return;
  state.quarantine = undefined;
  try {
    await quarantine.discard();
  } catch (e) {
    logError(ctx, "could not discard the quarantined objects", e);
  }
}

/**
 * Ends a receive-pack run: discards the quarantined objects it did not publish (a run that
 * stopped on an error, a client that went away). Drivers call it once `Fsm.run` returns or
 * throws; a run that reached the report has nothing left to discard.
 *
 * @example
 * ```ts
 * try {
 *   await fsm.run(ctx);
 * } finally {
 *   await releaseReceivePack(ctx);
 * }
 * ```
 */
export async function releaseReceivePack(ctx: ProcessContext): Promise<void> {
  await discardQuarantine(ctx);
}

/**
 * Thrown by a receive-pack hook when receive-pack itself dies there (git's `die()` while it
 * looks the hook up: a broken `hook.<name>.*` configuration): the push ends without a status
 * report, `fatal: <message>` on receive-pack's stderr (`output.error`), and the client hears
 * the remote end hang up.
 */
export class ReceivePackDiedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReceivePackDiedError";
  }
}

function isReceivePackDeath(error: unknown): boolean {
  return error instanceof Error && error.name === "ReceivePackDiedError";
}

/** A hook that did not answer within `hookTimeoutMs`. */
export class HookTimeoutError extends Error {
  constructor(
    readonly hook: string,
    readonly ms: number,
  ) {
    super(`${hook} hook timed out after ${ms} ms`);
    this.name = "HookTimeoutError";
  }
}

/**
 * Runs a hook, failing with {@link HookTimeoutError} once `hookTimeoutMs` passes (the hook
 * itself is not stopped; its late answer is ignored). No timeout without the option.
 */
async function timedHook<T>(
  ctx: ProcessContext,
  name: string,
  run: () => T | Promise<T>,
): Promise<T> {
  const ms = receivePackConfig(ctx).hookTimeoutMs;
  const pending = Promise.resolve().then(run);
  if (!ms || ms <= 0) return pending;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new HookTimeoutError(name, ms)), ms);
  });
  pending.catch(() => {}); // a late failure after the timeout is not unhandled
  try {
    return await Promise.race([pending, timeout]);
  } finally {
    clearTimeout(timer);
  }
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
/** A ref store's reference-transaction hook aborted the update (vcs-core's error). */
function isTransactionAborted(error: unknown): boolean {
  return error instanceof Error && error.name === "RefTransactionAbortedError";
}

function internalError(ctx: ProcessContext, error: unknown): string {
  const output = getOutput(ctx);
  output.error = error instanceof Error ? error.message : String(error);
  logError(ctx, "receive-pack failed", error);
  for (const cmd of getState<ServerPushState>(ctx).pushCommands ?? []) {
    if (cmd.result === "NOT_ATTEMPTED") reject(cmd, "internal error");
  }
  return "INTERNAL_ERROR";
}

/** Refuses the commands that would change a hidden ref, with git's texts. */
function rejectHiddenUpdates(ctx: ProcessContext, commands: PushCommand[]): void {
  const hidden = getConfig(ctx).hiddenRefs;
  if (!hidden?.length) return;
  for (const cmd of commands) {
    if (cmd.result !== "NOT_ATTEMPTED" || !isRefHidden(cmd.refName, hidden)) continue;
    reject(
      cmd,
      cmd.type === "DELETE" ? "deny deleting a hidden ref" : "deny updating a hidden ref",
    );
  }
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
      get repository() {
        return pushView(ctx);
      },
      get quarantinePath() {
        return state.quarantine?.path;
      },
      request: rp.request,
      repoPath: rp.repoPath,
      ...(rp.remoteUser !== undefined ? { remoteUser: rp.remoteUser } : {}),
      ...(rp.remoteAddr !== undefined ? { remoteAddr: rp.remoteAddr } : {}),
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
  const next = (state.bandQueue ?? Promise.resolve()).then(write).catch((error: unknown) => {
    // the client is gone (or stopped reading): no ref is updated after this, and the report
    // write will fail too
    state.peerGone ??= error;
  });
  state.bandQueue = next;
  return next;
}

/** Writes `text` on the progress channel (side-band only; nothing once the report is out). */
function sendMessage(ctx: ProcessContext, text: string): Promise<void> {
  const state = getState<ServerPushState>(ctx);
  // (after the report only while the band stays open for a relayed post-receive)
  const closed = state.reportSent && !state.flushAfterPostReceive;
  if (!state.capabilities.has("side-band-64k") || closed || !text) {
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

/** git's `rp_warning`: a `warning:` line on the progress channel, quiet or not. */
function sendWarning(ctx: ProcessContext, text: string): Promise<void> {
  return sendMessage(ctx, `warning: ${text}`);
}

/** A deny setting (`receive.denyCurrentBranch`, `receive.denyDeleteCurrent`) as an action. */
function denyActionOf(value: boolean | ReceiveDenyAction | undefined): ReceiveDenyAction {
  if (value === undefined || value === true) return "refuse";
  if (value === false) return "ignore";
  return value;
}

/** receive-pack.c's `refuse_unconfigured_deny_msg`. */
const REFUSE_UNCONFIGURED_DENY =
  "By default, updating the current branch in a non-bare repository\n" +
  "is denied, because it will make the index and work tree inconsistent\n" +
  "with what you pushed, and will require 'git reset --hard' to match\n" +
  "the work tree to HEAD.\n" +
  "\n" +
  "You can set the 'receive.denyCurrentBranch' configuration variable\n" +
  "to 'ignore' or 'warn' in the remote repository to allow pushing into\n" +
  "its current branch; however, this is not recommended unless you\n" +
  "arranged to update its work tree to match what you pushed in some\n" +
  "other way.\n" +
  "\n" +
  "To squelch this message and still keep the default behaviour, set\n" +
  "'receive.denyCurrentBranch' configuration variable to 'refuse'.";

/** receive-pack.c's `refuse_unconfigured_deny_delete_current_msg`. */
const REFUSE_UNCONFIGURED_DENY_DELETE_CURRENT =
  "By default, deleting the current branch is denied, because the next\n" +
  "'git clone' won't result in any file checked out, causing confusion.\n" +
  "\n" +
  "You can set 'receive.denyDeleteCurrent' configuration variable to\n" +
  "'warn' or 'ignore' in the remote repository to allow deleting the\n" +
  "current branch, with or without a warning message.\n" +
  "\n" +
  "To squelch this message, you can set it to 'refuse'.";

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
  const repository = pushView(ctx);
  if (repository.getObjectType) return repository.getObjectType(oid);
  if (repository.getCommitInfo) {
    if (await repository.getCommitInfo(oid, { checkExists: true })) return "commit";
    return (await repository.has(oid)) ? "other" : undefined;
  }
  return (await repository.has(oid)) ? "unknown" : undefined;
}

/**
 * The checks of git's `update()`, per command in order, then the update hook.
 *
 * An atomic push runs them as git's execute_commands_atomic: the first command refused here
 * stops the checks (the update hook of later commands does not run) and every other command
 * still open gets "atomic push failure" (a non-commit on a branch included, as git 2.55+).
 * What git's ref transaction refuses only when it commits (a stale old value, the same ref
 * twice) does not stop the checks; once they all pass, every open command gets "atomic transaction failed". With
 * `strictAtomic`, a command already refused before the transaction fails the others at once,
 * and so does a command `preReceive` refused by name (`rejectedRefs`, no git counterpart: it is
 * treated as git's update hook).
 */
async function validateCommands(ctx: ProcessContext): Promise<void> {
  const state = getState<ServerPushState>(ctx);
  const config = getConfig(ctx);
  const rp = receivePackConfig(ctx);
  const repository = getRepository(ctx);
  const refStore = getRefStore(ctx);
  const commands = state.pushCommands ?? [];
  const atomic = state.capabilities.has("atomic");
  const failOpen = (message: string) => {
    for (const c of commands) {
      if (c.result === "NOT_ATTEMPTED") {
        c.result = "ATOMIC_REJECTED";
        c.message = message;
      }
    }
  };

  if (atomic && rp.strictAtomic && commands.some((c) => c.result !== "NOT_ATTEMPTED")) {
    failOpen(ATOMIC_PUSH_FAILURE);
    return;
  }
  // refs preReceive refused one by one count as refused in update() (no update hook runs)
  if (atomic && state.preReceiveRefused?.size) {
    failOpen(ATOMIC_PUSH_FAILURE);
    return;
  }

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
  const denyCurrentBranch = denyActionOf(config.denyCurrentBranch);
  const denyDeleteCurrent = denyActionOf(rp.denyDeleteCurrent);
  // find_shared_symref over the worktrees: the branches a non-bare worktree's HEAD uses
  // (given), else the one HEAD names in a non-bare repository
  const checkedOut = new Set<string>(
    rp.checkedOutBranches ?? (!bare && head !== undefined ? [head] : []),
  );
  /** An atomic push whose ref transaction will refuse to commit */
  let transactionFails = false;

  // The same ref twice: git's ref transaction refuses ("multiple updates for ref")
  const seen = new Set<string>();
  for (const cmd of commands) {
    if (!seen.has(cmd.refName)) {
      seen.add(cmd.refName);
      continue;
    }
    await sendError(ctx, `multiple updates for ref '${cmd.refName}' not allowed`);
    if (atomic) {
      transactionFails = true;
      continue;
    }
    if (cmd.result === "NOT_ATTEMPTED") {
      cmd.result = "LOCK_FAILURE";
      cmd.message = FAILED_TO_UPDATE;
    }
  }

  const hook = receivePackHooks(ctx)?.update;

  /** git's `update()` for one command: refuses it, or leaves it open */
  const check = async (cmd: PushCommand): Promise<void> => {
    const name = cmd.refName;
    const isDelete = cmd.type === "DELETE";

    // only valid names under refs/ (one level allowed for a delete), never HEAD itself
    if (!name.startsWith("refs/") || !isValidRefName(name.slice(5), { allowOneLevel: isDelete })) {
      await sendError(ctx, `refusing to update funny ref '${name}' remotely`);
      reject(cmd, "funny refname");
      return;
    }

    let updateWorktree = false;
    if (checkedOut.has(name)) {
      if (denyCurrentBranch === "warn") await sendWarning(ctx, "updating the current branch");
      else if (denyCurrentBranch === "updateInstead") updateWorktree = true;
      else if (denyCurrentBranch !== "ignore") {
        await sendError(ctx, `refusing to update checked out branch: ${name}`);
        if (denyCurrentBranch === "unconfigured") await sendError(ctx, REFUSE_UNCONFIGURED_DENY);
        cmd.result = "REJECTED_CURRENT_BRANCH";
        cmd.message = "branch is currently checked out";
        return;
      }
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
        return;
      }
      if (checkedOut.has(name) || head === name) {
        if (denyDeleteCurrent === "warn") await sendWarning(ctx, "deleting the current branch");
        else if (denyDeleteCurrent !== "ignore") {
          if (denyDeleteCurrent === "unconfigured") {
            await sendError(ctx, REFUSE_UNCONFIGURED_DENY_DELETE_CURRENT);
          }
          await sendError(ctx, `refusing to delete the current branch: ${name}`);
          cmd.result = "REJECTED_NODELETE";
          cmd.message = "deletion of the current branch prohibited";
          return;
        }
      }
    }

    if (cmd.expectedOid !== undefined) {
      await sendMessage(ctx, "warning: allowing deletion of corrupt ref");
    }

    // the old value the client saw (git's ref transaction checks it, when it commits)
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
      if (!atomic) {
        cmd.result = "LOCK_FAILURE";
        cmd.message = FAILED_TO_UPDATE;
        return;
      }
      transactionFails = true;
    }

    let nonCommitBranch = false;
    if (!isDelete) {
      const type = await objectType(ctx, cmd.newOid);
      if (type === undefined) {
        // connectivity found it (a facade without the object walk): git's "bad pack"
        await sendError(ctx, `unpack should have generated ${cmd.newOid}, but I can't find it!`);
        cmd.result = "REJECTED_MISSING_OBJECT";
        cmd.message = "bad pack";
        return;
      }
      // a branch points at a commit: refused once the update hook has run, as git 2.55+'s
      // ref_transaction_update (queued in update(), after the hook)
      nonCommitBranch = name.startsWith("refs/heads/") && type !== "commit" && type !== "unknown";
    }

    if (cmd.type === "UPDATE" && name.startsWith("refs/heads/") && !nonCommitBranch) {
      const oldType = await objectType(ctx, cmd.oldOid);
      if (oldType !== "commit" && oldType !== "unknown") {
        await sendError(ctx, `bad sha1 objects for ${name}`);
        reject(cmd, "bad ref");
        return;
      }
      if (!(await isAncestor(ctx, cmd.oldOid, cmd.newOid))) {
        if (!config.allowNonFastForward) {
          await sendError(ctx, `denying non-fast-forward ${name} (you should pull first)`);
          cmd.result = "REJECTED_NONFASTFORWARD";
          cmd.message = "non-fast-forward";
          return;
        }
        cmd.type = "UPDATE_NONFASTFORWARD";
      }
    }

    if (hook) {
      let verdict: ReturnType<typeof normalizeVerdict>;
      try {
        verdict = normalizeVerdict(
          await timedHook(ctx, "update", () =>
            hook(name, cmd.oldOid, cmd.newOid, hookContext(ctx)),
          ),
        );
      } catch (e) {
        if (isReceivePackDeath(e)) throw e;
        logError(ctx, `update hook failed for ${name}`, e);
        await sendError(ctx, "update hook error");
        verdict = { ok: false };
      }
      if (!verdict.ok) {
        if (verdict.message) await sendMessage(ctx, verdict.message);
        await sendError(ctx, `hook declined to update ${name}`);
        reject(cmd, "hook declined");
        return;
      }
    }

    // receive.denyCurrentBranch=updateInstead: the worktree takes the new commit first
    // (git's update_worktree, after the update hook), or the update is refused
    if (updateWorktree) {
      let refusal: string | undefined;
      try {
        // git migrates the quarantined objects before update(): the worktree reads them
        if (rp.updateWorktree) await publishQuarantine(ctx);
        refusal = rp.updateWorktree
          ? await rp.updateWorktree(name, cmd.newOid, hookContext(ctx))
          : "denyCurrentBranch = updateInstead needs a worktree";
      } catch (e) {
        logError(ctx, `updating the worktree of ${name} failed`, e);
        refusal = "Could not update working tree to new HEAD";
      }
      if (refusal) {
        reject(cmd, refusal);
        return;
      }
    }

    // git 2.55+ refuses it in ref_transaction_update with REF_TRANSACTION_ERROR_INVALID_NEW_VALUE,
    // reported "invalid new value provided" (and an atomic push fails the others with "atomic
    // push failure"); older git refused it when the transaction committed ("failed to update
    // ref" in 2.43, "atomic transaction failed" for an atomic push)
    if (nonCommitBranch) {
      await sendError(ctx, `trying to write non-commit object ${cmd.newOid} to branch '${name}'`);
      cmd.result = "LOCK_FAILURE";
      cmd.message = INVALID_NEW_VALUE;
    }
  };

  // git 2.43's execute_commands_non_atomic: each command's ref transaction right after its
  // checks and update hook (the objects migrated before the first)
  const batch = refStore.batch?.bind(refStore);
  const eager =
    !atomic && rp.interleaveUpdateHook === true && !!batch && !state.shallowConnectivity;
  // git 2.5x's execute_commands_non_atomic: update() for the deletions, their transaction
  // committed, then update() for the rest and theirs
  if (!atomic && !eager && rp.batchNonAtomic === true && batch && !state.shallowConnectivity) {
    for (const deletions of [true, false]) {
      const phase = commands.filter(
        (c) => c.result === "NOT_ATTEMPTED" && (c.newOid === ZERO_OID) === deletions,
      );
      if (phase.length === 0) continue;
      for (const cmd of phase) await check(cmd);
      // a client that went away mid-check gets no ref update (git dies on the failed write)
      if (state.peerGone !== undefined) {
        state.phasesApplied = true;
        return;
      }
      // a delete of a ref that does not exist joins the transaction (its hook hears it)
      const pending = phase.filter((c) => c.result === "NOT_ATTEMPTED");
      if (pending.some((c) => !isNoop(c))) await publishQuarantine(ctx);
      const applied = await applyPhase(batch, pending, true);
      for (const c of pending) {
        if (applied.has(c) || isNoop(c)) c.result = "OK";
        else {
          c.result = "LOCK_FAILURE";
          c.message = FAILED_TO_UPDATE;
        }
      }
    }
    // post-receive's commands in the order the commands came
    state.eagerlyApplied = commands.filter((c) => c.result === "OK" && !isNoop(c));
    state.appliedCommands = [...state.eagerlyApplied];
    state.phasesApplied = true;
    return;
  }
  for (const cmd of commands) {
    if (cmd.result !== "NOT_ATTEMPTED") continue;
    await check(cmd);
    // git's execute_commands_atomic: the first refusal fails the transaction
    if (atomic && cmd.result !== "NOT_ATTEMPTED") {
      failOpen(ATOMIC_PUSH_FAILURE);
      return;
    }
    if (eager && batch && cmd.result === "NOT_ATTEMPTED") {
      const noop = isNoop(cmd);
      if (!noop) await publishQuarantine(ctx);
      let ok = false;
      try {
        ok = (await batch([toRefCommand(cmd)], { message: "push" })).ok;
      } catch (e) {
        if (isTransactionAborted(e)) throw e;
      }
      if (noop) {
        // git's transaction of a delete of a ref that does not exist: nothing to apply
        cmd.result = "OK";
      } else if (ok) {
        cmd.result = "OK";
        state.eagerlyApplied = [...(state.eagerlyApplied ?? []), cmd];
        state.appliedCommands = [...state.eagerlyApplied];
      } else {
        cmd.result = "LOCK_FAILURE";
        cmd.message = FAILED_TO_UPDATE;
      }
    }
  }
  if (transactionFails) failOpen(ATOMIC_TRANSACTION_FAILED);
}

/** Whether `ancestor` is reachable from `oid` through parents. */
function isAncestor(ctx: ProcessContext, ancestor: string, oid: string): Promise<boolean> {
  return isAncestorOf(pushView(ctx), ancestor, oid);
}

/**
 * A delete of a ref that does not exist: nothing to do, reported ok (git warns, and queues
 * it in its ref transaction all the same, so the reference-transaction hook hears it; it is
 * not among the commands post-receive and post-update are told of: `did_not_exist`).
 */
function isNoop(cmd: PushCommand): boolean {
  return cmd.oldOid === ZERO_OID && cmd.newOid === ZERO_OID && cmd.expectedOid === undefined;
}

/** The batch command for a push command; git's zero id means "absent" on both sides. */
function toRefCommand(cmd: PushCommand): RefCommand {
  // git's ref_transaction_delete with no old value: nothing to check, nothing to remove
  if (isNoop(cmd)) return { name: cmd.refName, new: null, noDeref: true };
  return {
    name: cmd.refName,
    old: cmd.expectedOid ?? (cmd.oldOid === ZERO_OID ? null : cmd.oldOid),
    new: cmd.newOid === ZERO_OID ? null : cmd.newOid,
    noDeref: true, // receive-pack names refs directly, as git does
  };
}

type ApplyResult = "UPDATES_APPLIED" | "PARTIAL_APPLIED" | "ATOMIC_FAILED";

/**
 * Whether an atomic push must apply none of its commands: a command refused inside the ref
 * transaction (git's `update()`), or any refused command with `strictAtomic`. Commands refused
 * before the transaction (connectivity, shallow, authorize, pre-receive) do not count, as in
 * git's execute_commands_atomic, which skips them. Without that record (APPLY_UPDATES run on
 * its own) every refusal counts.
 */
function atomicBlocked(ctx: ProcessContext, state: ServerPushState): boolean {
  const early = receivePackConfig(ctx).strictAtomic ? undefined : state.refusedBeforeTransaction;
  return (state.pushCommands ?? []).some((c) => c.result !== "NOT_ATTEMPTED" && !early?.has(c));
}

/**
 * Apply the push commands still `NOT_ATTEMPTED`, as git's receive-pack does in
 * a ref transaction.
 *
 * - An atomic push that is `blocked` (a command refused inside the transaction, or any
 *   refused command with `strictAtomic`) changes nothing: the others get "atomic push
 *   failure". Commands refused before the transaction keep their errors and the rest is
 *   applied, as git does.
 * - With `refStore.batch`, an atomic push is one batch (all refs or none, every
 *   command "atomic transaction failed" when refused) and a plain push one batch
 *   per ref ("failed to update ref"). Each update checks the old id the client
 *   sent. A store whose batch answers `unsupported` (not atomic for several refs)
 *   gets the one-by-one path.
 * - Without `batch`, refs are written one by one with `update`.
 * - Deleting a ref that does not exist is a no-op reported ok, as git does; it is not
 *   among the applied commands (post-receive does not see it). With `batch` it joins the
 *   transaction (git queues it: the reference-transaction hook hears `<zero> <zero> <ref>`).
 */
async function applyUpdates(
  state: ServerPushState,
  refStore: RefStore,
  atomic: boolean,
  blocked = (state.pushCommands ?? []).some((c) => c.result !== "NOT_ATTEMPTED"),
  /** Not atomic: the deletions in one batch, then the rest (see `batchNonAtomic`) */
  batchNonAtomic = false,
): Promise<ApplyResult> {
  const all = state.pushCommands ?? [];
  const open = all.filter((c) => c.result === "NOT_ATTEMPTED");
  state.appliedCommands = [...(state.eagerlyApplied ?? [])];
  if (atomic && blocked) {
    for (const c of open) {
      c.result = "ATOMIC_REJECTED";
      c.message = ATOMIC_PUSH_FAILURE;
    }
    return "ATOMIC_FAILED";
  }
  const batch = refStore.batch?.bind(refStore);
  // without a batch a delete of a ref that does not exist is nothing to write
  if (!batch) for (const c of open) if (isNoop(c)) c.result = "OK";
  const pending = open.filter((c) => c.result === "NOT_ATTEMPTED");
  // a failed transaction fails the commands it held; those refused before keep their errors
  const failTransaction = (): "ATOMIC_FAILED" => {
    for (const c of open) {
      c.result = "ATOMIC_REJECTED";
      c.message = ATOMIC_TRANSACTION_FAILED;
    }
    state.appliedCommands = [];
    return "ATOMIC_FAILED";
  };
  const okCount = () => all.filter((c) => c.result === "OK").length;

  if (!batch) return applyOneByOne(state, refStore, atomic, pending, failTransaction);
  const options = { message: "push" };

  if (atomic) {
    if (pending.length === 0) return "UPDATES_APPLIED";
    let result: Awaited<ReturnType<typeof batch>>;
    try {
      result = await batch(pending.map(toRefCommand), options);
    } catch (e) {
      if (isTransactionAborted(e)) throw e;
      result = { ok: false, rejected: pending.map((c) => ({ name: c.refName, reason: "locked" })) };
    }
    if (result.ok) {
      for (const c of pending) c.result = "OK";
      state.appliedCommands = pending.filter((c) => !isNoop(c));
      return "UPDATES_APPLIED";
    }
    if (result.rejected.every((r) => r.reason === "unsupported")) {
      for (const c of pending) if (isNoop(c)) c.result = "OK";
      return applyOneByOne(
        state,
        refStore,
        atomic,
        pending.filter((c) => !isNoop(c)),
        failTransaction,
      );
    }
    return failTransaction();
  }

  // git 2.5x: one batch for the deletions, one for the rest (see applyPhase)
  const applied = new Set<PushCommand>();
  const phases = batchNonAtomic
    ? [pending.filter((c) => c.type === "DELETE"), pending.filter((c) => c.type !== "DELETE")]
    : [pending];
  // the commands git's update() took up (no refusal before it): a phase that had some
  // commits its transaction even when update() refused them all
  const considered = all.filter((c) => !state.refusedBeforeTransaction?.has(c));
  for (const phase of phases) {
    if (batchNonAtomic && phase.length === 0) {
      const deletions = phase === phases[0];
      if (considered.some((c) => (c.type === "DELETE") === deletions)) {
        await applyPhase(batch, [], true);
      }
      continue;
    }
    for (const c of await applyPhase(batch, phase, batchNonAtomic)) applied.add(c);
  }
  // the results (and post-receive's commands) in the order the commands came
  for (const c of pending) {
    if (isNoop(c)) {
      c.result = "OK";
    } else if (applied.has(c)) {
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
 * Applies the commands of one phase of a push that is not atomic: with `together` (git
 * 2.5x), one transaction for them all (an empty one is committed too, as git commits the
 * transaction update() began), and a batch that fails (a ref refused under its locks) is
 * applied ref by ref, as REF_TRANSACTION_ALLOW_FAILURE refuses only the refs that fail;
 * else one batch per ref. A refusing reference-transaction hook throws. The commands
 * applied.
 */
async function applyPhase(
  batch: NonNullable<RefStore["batch"]>,
  phase: PushCommand[],
  together: boolean,
): Promise<Set<PushCommand>> {
  const options = { message: "push" };
  const applied = new Set<PushCommand>();
  if (together && phase.length === 0) {
    await batch([], { ...options, emptyTransaction: true });
    return applied;
  }
  if (together && phase.length > 1) {
    try {
      if ((await batch(phase.map(toRefCommand), options)).ok) {
        for (const c of phase) applied.add(c);
      }
    } catch (e) {
      if (isTransactionAborted(e)) throw e;
    }
  }
  for (const c of phase) {
    if (applied.has(c)) continue;
    try {
      if ((await batch([toRefCommand(c)], options)).ok) applied.add(c);
    } catch (e) {
      if (isTransactionAborted(e)) throw e;
    }
  }
  return applied;
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
  failTransaction: () => "ATOMIC_FAILED",
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
        return failTransaction();
      }
    }
  }

  state.appliedCommands = appliedCommands;
  return all.every((c) => c.result === "OK") ? "UPDATES_APPLIED" : "PARTIAL_APPLIED";
}

/** The side-band's closing flush SEND_STATUS left for after a relayed post-receive. */
async function closeRelayedBand(ctx: ProcessContext): Promise<void> {
  const state = getState<ServerPushState>(ctx);
  if (!state.flushAfterPostReceive) return;
  state.flushAfterPostReceive = false;
  await getTransport(ctx).writeFlush();
}
