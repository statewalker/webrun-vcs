/**
 * Server-side fetch (upload-pack) hooks and settings: an authorization hook that sees what a
 * client asks for before any pack is written, and a notification once a pack went out.
 */

import type { RepositoryFacade } from "../../api/repository-facade.js";
import type { ProcessConfiguration } from "../../context/process-config.js";
import type { RefStore } from "../../context/process-context.js";
import { isRefHidden } from "../../protocol/hidden-refs.js";
import type {
  HookVerdict,
  ReceivePackLogger,
  ReceivePackRequestInfo,
} from "../push/receive-pack-types.js";

/** What a fetch asks for, as upload-pack's hooks see it. */
export interface UploadPackRequest {
  /** The wire protocol: 0 (v0/v1) or 2 */
  readonly protocolVersion: 0 | 2;
  /** The object ids wanted (`want` lines, and the tips of v2 `want-ref` lines) */
  readonly wants: readonly string[];
  /** The visible refs whose tip is wanted (`want-ref` names included), sorted */
  readonly refs: readonly string[];
  /** v2 `want-ref` lines: ref name → id */
  readonly wantRefs: ReadonlyMap<string, string>;
  /**
   * The client's `have` lines. Over v2 a fetch command carries them all; over v0 the hook runs
   * before the negotiation, so none are known yet (empty).
   */
  readonly haves: readonly string[];
  /** The client's capabilities (v0), or the `fetch` arguments it sent (v2: `thin-pack`, …) */
  readonly capabilities: ReadonlySet<string>;
  /** The client's shallow commits */
  readonly shallow: readonly string[];
  /** `deepen <depth>` (0: none) */
  readonly depth: number;
  /** `filter <spec>`, when asked */
  readonly filter?: string;
}

/** What upload-pack's hooks are told about the connection. */
export interface UploadPackHookContext {
  /** The HTTP request, for fetches over smart HTTP */
  readonly request?: ReceivePackRequestInfo;
  /** The repository path of the HTTP request */
  readonly repoPath?: string;
  /** The served repository */
  readonly repository: RepositoryFacade;
}

/** What `postUpload` is told once a pack was sent. */
export interface UploadPackResult extends UploadPackRequest {
  /** The common commits the pack was cut at (the client's haves the server has) */
  readonly common: readonly string[];
  /** Bytes of the pack written (without pkt-line or side-band framing) */
  readonly packBytes: number;
}

/**
 * upload-pack's hooks, wired like receive-pack's.
 *
 * @example
 * ```ts
 * const uploadPack: UploadPackServerOptions = {
 *   hooks: {
 *     authorize: (request, ctx) =>
 *       request.refs.every((ref) => !ref.startsWith("refs/heads/private/")) ||
 *       ctx.request?.headers.authorization === "Bearer secret" ||
 *       "access denied",
 *     postUpload: (result) => metrics.count("fetch", result.packBytes),
 *   },
 * };
 * ```
 */
export interface UploadPackHooks {
  /**
   * Decides on a fetch once its wants are read and accepted by the request policy, before the
   * negotiation (v0) or the response (v2) and before any pack byte: refusing answers
   * `ERR <message>` (default "access denied"), which git shows as `remote error: <message>`.
   * Called for every request: over stateless smart HTTP each POST of a negotiation carries the
   * wants again, so it runs once per round there. A hook that throws refuses with
   * "authorization failed" (the error goes to the log, never to the client). `rejectedRefs`
   * of a {@link HookResult} refuses the whole fetch.
   */
  authorize?(
    request: UploadPackRequest,
    ctx: UploadPackHookContext,
  ): HookVerdict | Promise<HookVerdict>;
  /**
   * Called once a pack was sent in full. Detached: it cannot change the outcome, and what it
   * throws is logged.
   */
  postUpload?(result: UploadPackResult, ctx: UploadPackHookContext): unknown;
}

/** upload-pack settings (`ProcessConfiguration.uploadPack`). */
export interface UploadPackConfig {
  /** The hooks */
  hooks?: UploadPackHooks;
  /** The HTTP request (for the hooks) */
  request?: ReceivePackRequestInfo;
  /** The repository path (for the hooks) */
  repoPath?: string;
  /** Logs hook failures (default: console.error) */
  logger?: ReceivePackLogger;
}

/** The reason given when the authorize hook throws (details: the log). */
export const UPLOAD_PACK_AUTHORIZE_FAILED = "authorization failed";

/** The ERR text of a refusal without a message. */
export const UPLOAD_PACK_ACCESS_DENIED = "access denied";

/** The parts of a request a driver knows; `refs` is filled in here. */
export type UploadPackRequestParts = Omit<UploadPackRequest, "refs">;

/**
 * Runs the authorize hook: undefined when the fetch may go on, else the `ERR` text.
 */
export async function authorizeUpload(
  config: ProcessConfiguration,
  refStore: RefStore,
  repository: RepositoryFacade,
  parts: UploadPackRequestParts,
): Promise<string | undefined> {
  const hook = config.uploadPack?.hooks?.authorize;
  if (!hook) return undefined;
  try {
    const request = await withRefs(config, refStore, parts);
    const verdict = await hook(request, uploadHookContext(config, repository));
    if (verdict === undefined || verdict === true) return undefined;
    if (verdict === false) return UPLOAD_PACK_ACCESS_DENIED;
    if (typeof verdict === "string") return oneLine(verdict) || UPLOAD_PACK_ACCESS_DENIED;
    if (verdict.ok && !verdict.rejectedRefs?.length) return undefined;
    return oneLine(verdict.message ?? "") || UPLOAD_PACK_ACCESS_DENIED;
  } catch (e) {
    logUploadError(config, "upload-pack authorize hook failed", e);
    return UPLOAD_PACK_AUTHORIZE_FAILED;
  }
}

/** Starts the postUpload hook, detached, once a pack went out. */
export function notifyUpload(
  config: ProcessConfiguration,
  refStore: RefStore,
  repository: RepositoryFacade,
  parts: UploadPackRequestParts,
  result: { common: Iterable<string>; packBytes: number },
): void {
  const hook = config.uploadPack?.hooks?.postUpload;
  if (!hook) return;
  const common = [...result.common];
  setTimeout(() => {
    void (async () => {
      try {
        const request = await withRefs(config, refStore, parts);
        await hook(
          { ...request, common, packBytes: result.packBytes },
          uploadHookContext(config, repository),
        );
      } catch (e) {
        logUploadError(config, "upload-pack post-upload hook failed", e);
      }
    })();
  }, 0);
}

/**
 * The annotated tags upload-pack may add to a pack for `include-tag` (git's
 * `pack-objects --include-tag`, over `refs/tags/*`): the ids of the visible tag refs. git
 * also tries hidden tags; they stay out here, so a hidden tag never reaches a client.
 */
export async function includeTagCandidates(
  config: ProcessConfiguration,
  refStore: RefStore,
): Promise<string[]> {
  const ids = new Set<string>();
  for (const [name, oid] of await refStore.listAll()) {
    if (name.startsWith("refs/tags/") && !isRefHidden(name, config.hiddenRefs)) ids.add(oid);
  }
  return [...ids];
}

async function withRefs(
  config: ProcessConfiguration,
  refStore: RefStore,
  parts: UploadPackRequestParts,
): Promise<UploadPackRequest> {
  const wanted = new Set(parts.wants);
  const refs = new Set(parts.wantRefs.keys());
  for (const [name, oid] of await refStore.listAll()) {
    if (wanted.has(oid) && !isRefHidden(name, config.hiddenRefs)) refs.add(name);
  }
  return { ...parts, refs: [...refs].sort() };
}

function uploadHookContext(
  config: ProcessConfiguration,
  repository: RepositoryFacade,
): UploadPackHookContext {
  const up = config.uploadPack ?? {};
  return { request: up.request, repoPath: up.repoPath, repository };
}

function logUploadError(config: ProcessConfiguration, message: string, error: unknown): void {
  const logger = config.uploadPack?.logger;
  if (logger) logger.error(message, error);
  else console.error(message, error);
}

function oneLine(text: string): string {
  return text.replace(/\s*\n[\s\S]*$/, "").trim();
}
