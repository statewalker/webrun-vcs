/**
 * Server-side push (receive-pack) hooks and settings.
 */

import type { PushCommandType } from "./types.js";

/** A push command as receive-pack's hooks see it. */
export interface ReceiveCommand {
  /** Full ref name */
  readonly refName: string;
  /** The value the client expects the ref to have (zero id: absent) */
  readonly oldOid: string;
  /** The value to set (zero id: delete) */
  readonly newOid: string;
  /** Create, update or delete */
  readonly type: PushCommandType;
}

/** The smart-HTTP request a push came in (handed to the hooks by the HTTP handlers). */
export interface ReceivePackRequestInfo {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
}

/** What receive-pack's hooks are told about the push. */
export interface ReceivePackHookContext {
  /** The capabilities the client asked for */
  readonly capabilities: ReadonlySet<string>;
  /** The push options (`git push -o`) */
  readonly pushOptions: readonly string[];
  /** The client's shallow commits (`shallow` lines) */
  readonly shallow: readonly string[];
  /** The HTTP request, for pushes over smart HTTP */
  readonly request?: ReceivePackRequestInfo;
  /** The repository path of the HTTP request */
  readonly repoPath?: string;
  /**
   * Shows `text` to the pushing user (side-band channel 2, as git relays a hook's output;
   * nothing without side-band).
   */
  message(text: string): Promise<void>;
}

/** A hook's answer for a set of commands. */
export interface HookResult {
  /** false: refused */
  ok: boolean;
  /** Why (authorize: the report's reason; other hooks: shown to the user) */
  message?: string;
  /** Refuse only these refs; the others go on (absent: all) */
  rejectedRefs?: string[];
}

/**
 * A hook's verdict: nothing or `true` accepts; `false` refuses; a string refuses with that
 * message; a {@link HookResult} says which refs.
 */
export type HookVerdict = undefined | boolean | string | HookResult;

/**
 * receive-pack's hooks, as git's (`pre-receive`, `update`, `post-receive`) plus an
 * authorization hook that runs before the pack is read.
 *
 * @example
 * ```ts
 * const hooks: ReceivePackHooks = {
 *   authorize: (commands, ctx) =>
 *     ctx.request?.headers.authorization === "Bearer secret" ? true : "permission denied",
 *   update: (refName) => (refName === "refs/heads/locked" ? "branch is locked" : undefined),
 *   postReceive: (commands) => notifyCi(commands),
 * };
 * ```
 */
export interface ReceivePackHooks {
  /**
   * Decides on the commands before any pack byte is read. Refusing the whole push answers
   * HTTP 403 over smart HTTP (the body is not read) and `ng <ref> <message>` for every
   * command elsewhere; refusing some refs answers `ng` for those. A push whose every command
   * needing the pack is refused does not store the pack.
   */
  authorize?(
    commands: readonly ReceiveCommand[],
    ctx: ReceivePackHookContext,
  ): HookVerdict | Promise<HookVerdict>;
  /**
   * git's pre-receive: once the pack is in and connected, before any ref moves. Refusing
   * answers `ng <ref> pre-receive hook declined` (the message goes to the user).
   */
  preReceive?(
    commands: readonly ReceiveCommand[],
    ctx: ReceivePackHookContext,
  ): HookVerdict | Promise<HookVerdict>;
  /**
   * git's update hook, once per ref about to move: refusing answers `ng <ref> hook declined`
   * for that ref only (all of them in an atomic push).
   */
  update?(
    refName: string,
    oldOid: string,
    newOid: string,
    ctx: ReceivePackHookContext,
  ): HookVerdict | Promise<HookVerdict>;
  /**
   * git's post-receive: the commands whose refs moved, after the report went to the client.
   * Detached: it cannot change the outcome, and what it throws is logged.
   */
  postReceive?(commands: readonly ReceiveCommand[], ctx: ReceivePackHookContext): unknown;
}

/** A logger for receive-pack (hook failures after the report). */
export interface ReceivePackLogger {
  error(message: string, error?: unknown): void;
}

/** Default most commands one push may carry. */
export const DEFAULT_MAX_PUSH_COMMANDS = 65536;

/** Default keep-alive interval (git's `receive.keepAlive`, seconds there). */
export const DEFAULT_RECEIVE_KEEP_ALIVE_MS = 5000;

/**
 * receive-pack settings (`ProcessConfiguration.receivePack`). The ref policies
 * `allowDeletes`, `allowNonFastForward`, `denyCurrentBranch` and `currentBranch` are
 * `ProcessConfiguration` fields.
 */
export interface ReceivePackConfig {
  /** The hooks */
  hooks?: ReceivePackHooks;
  /**
   * Most commands in one push; more is a protocol error (HTTP 400 over smart HTTP).
   * Default {@link DEFAULT_MAX_PUSH_COMMANDS}.
   */
  maxCommands?: number;
  /**
   * Side-band keep-alive interval (ms) once the pack is read, while the push is checked and
   * applied (git's `receive.keepAlive`, default 5 s; 0: none).
   */
  keepAliveMs?: number;
  /** Whether the repository has no working tree (default: the facade's `isBare()`, else true) */
  bare?: boolean;
  /**
   * Refuse deleting the branch HEAD names, "deletion of the current branch prohibited"
   * (git's `receive.denyDeleteCurrent`, default true).
   */
  denyDeleteCurrent?: boolean;
  /**
   * Accept pushes from a shallow client whose history ends at its shallow commits (git's
   * `receive.shallowUpdate`, default false: "shallow update not allowed"). Needs the facade's
   * `updateShallow`.
   */
  shallowUpdate?: boolean;
  /** The HTTP request (for the hooks) */
  request?: ReceivePackRequestInfo;
  /** The repository path (for the hooks) */
  repoPath?: string;
  /** Logs hook failures that cannot reach the client */
  logger?: ReceivePackLogger;

  // Driver integration (set by the HTTP and duplex handlers)

  /**
   * "fatal": a push `authorize` refuses as a whole ends the run with
   * `HandlerOutput.authorizationDenied` set (the HTTP handlers answer 403) instead of a report.
   */
  authorizeFailure?: "report" | "fatal";
  /**
   * Read and discard a pack nothing will use (every command needing it refused before it was
   * read). True for streams where the client blocks until its pack is taken (a pipe); false
   * for HTTP, where the body is left unread.
   */
  drainRefusedPack?: boolean;
  /** Called once the commands are read and authorized, before the pack is read */
  onAuthorized?: () => void;
  /**
   * Takes the post-receive task, to run once the report reached the client (the driver closes
   * its stream first). Absent: the task starts on its own, detached.
   */
  afterReport?: (task: () => Promise<void>) => void;
}
