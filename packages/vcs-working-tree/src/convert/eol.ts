/**
 * End-of-line conversion as git's `convert.c` does it: `crlf_to_git` (clean),
 * `crlf_to_worktree` (smudge), the round-trip checks of `core.safecrlf`, and the choice of
 * line ending (`output_eol`, `text_eol_is_crlf`).
 */

import { gatherTextStats, isBinaryStats, type TextStats } from "./text-stats.js";

/**
 * What git does with line endings of a path (`enum convert_crlf_action`): `binary` leaves
 * them, `text-input` normalises to LF on check-in, `text-crlf` also writes CRLF on
 * checkout, the `auto` variants do the same for files git does not guess to be binary,
 * `text` and `auto` follow `core.eol` / `core.autocrlf`; `undefined` is nothing set.
 */
export type CrlfAction =
  | "undefined"
  | "binary"
  | "text"
  | "text-input"
  | "text-crlf"
  | "auto"
  | "auto-crlf"
  | "auto-input";

/** `core.autocrlf` */
export type AutoCrlf = "true" | "false" | "input";
/** `core.eol` (`native` resolved by the caller to the platform's line ending) */
export type CoreEol = "lf" | "crlf" | "native" | "unset";
/** `core.safecrlf`: `warn` (default), `die` (true) or `off` (false) */
export type SafeCrlf = "warn" | "die" | "off";

/** The line-ending settings of the configuration. */
export interface EolSettings {
  autocrlf: AutoCrlf;
  eol: CoreEol;
  safecrlf: SafeCrlf;
  /** The platform's line ending (`EOL_NATIVE`): CRLF on Windows, LF elsewhere */
  native: "lf" | "crlf";
}

/** git's defaults: autocrlf false, eol unset, safecrlf warn, native LF. */
export const DEFAULT_EOL_SETTINGS: EolSettings = {
  autocrlf: "false",
  eol: "unset",
  safecrlf: "warn",
  native: "lf",
};

const isAuto = (a: CrlfAction) => a === "auto" || a === "auto-input" || a === "auto-crlf";

/** git's `text_eol_is_crlf`. */
export function textEolIsCrlf(settings: EolSettings): boolean {
  if (settings.autocrlf === "true") return true;
  if (settings.autocrlf === "input") return false;
  if (settings.eol === "crlf") return true;
  if ((settings.eol === "unset" || settings.eol === "native") && settings.native === "crlf") {
    return true;
  }
  return false;
}

/** git's `output_eol`: the line ending a checkout writes. */
export function outputEol(action: CrlfAction, settings: EolSettings): "lf" | "crlf" | "unset" {
  switch (action) {
    case "binary":
      return "unset";
    case "text-crlf":
      return "crlf";
    case "text-input":
      return "lf";
    case "undefined":
    case "auto-crlf":
      return "crlf";
    case "auto-input":
      return "lf";
    case "text":
    case "auto":
      return textEolIsCrlf(settings) ? "crlf" : "lf";
  }
}

/** git's `will_convert_lf_to_crlf`. */
export function willConvertLfToCrlf(
  stats: TextStats,
  action: CrlfAction,
  settings: EolSettings,
): boolean {
  if (outputEol(action, settings) !== "crlf") return false;
  if (!stats.lonelf) return false;
  if (isAuto(action)) {
    // any CR or CRLF: not touched (the safer autocrlf handling)
    if (stats.lonecr || stats.crlf) return false;
    if (isBinaryStats(stats)) return false;
  }
  return true;
}

/** How a clean (check-in) treats line endings. */
export interface CrlfToGitOptions {
  /** The index already holds this path with CRLF (git's `has_crlf_in_index`) */
  hasCrlfInIndex?: () => Promise<boolean>;
  /** Renormalising: the index's CRLF does not hold the conversion back */
  renormalize?: boolean;
  /** The round-trip check to apply (`core.safecrlf`, only when writing an object) */
  roundTrip?: "warn" | "die";
  /** Receives git's round-trip warning */
  onWarning?: (message: string) => void;
}

/** The error a clean raises when `core.safecrlf=true` refuses a change of line endings. */
export class SafeCrlfError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SafeCrlfError";
  }
}

/** git's `check_global_conv_flags_eol`. */
function checkRoundTrip(
  path: string,
  oldStats: TextStats,
  newStats: TextStats,
  mode: "warn" | "die",
  onWarning?: (message: string) => void,
): void {
  if (oldStats.crlf && !newStats.crlf) {
    if (mode === "die") throw new SafeCrlfError(`CRLF would be replaced by LF in ${path}`);
    onWarning?.(
      `in the working copy of '${path}', CRLF will be replaced by LF the next time Git touches it`,
    );
  } else if (oldStats.lonelf && !newStats.lonelf) {
    if (mode === "die") throw new SafeCrlfError(`LF would be replaced by CRLF in ${path}`);
    onWarning?.(
      `in the working copy of '${path}', LF will be replaced by CRLF the next time Git touches it`,
    );
  }
}

/**
 * git's `crlf_to_git`: the content with CRLF turned into LF where `action` asks for it, or
 * the same array when nothing changes.
 */
export async function crlfToGit(
  path: string,
  src: Uint8Array,
  action: CrlfAction,
  settings: EolSettings,
  options: CrlfToGitOptions = {},
): Promise<Uint8Array> {
  if (action === "binary" || src.length === 0) return src;
  const stats = gatherTextStats(src);
  let convert = stats.crlf > 0;
  if (isAuto(action)) {
    if (isBinaryStats(stats)) return src;
    // CR in the index: not converted (the safer autocrlf handling), unless renormalising
    if (convert && !options.renormalize && (await options.hasCrlfInIndex?.())) convert = false;
  }
  if (options.roundTrip === "warn" || (options.roundTrip === "die" && src.length)) {
    const newStats = { ...stats };
    // simulate "git add"
    if (convert) {
      newStats.lonelf += newStats.crlf;
      newStats.crlf = 0;
    }
    // simulate "git checkout"
    if (willConvertLfToCrlf(newStats, action, settings)) {
      newStats.crlf += newStats.lonelf;
      newStats.lonelf = 0;
    }
    checkRoundTrip(path, stats, newStats, options.roundTrip, options.onWarning);
  }
  if (!convert) return src;
  const out = new Uint8Array(src.length);
  let n = 0;
  if (isAuto(action)) {
    // a lone CR made it binary above: every CR goes
    for (let i = 0; i < src.length; i++) if (src[i] !== 13) out[n++] = src[i];
  } else {
    for (let i = 0; i < src.length; i++) {
      const c = src[i];
      if (!(c === 13 && i + 1 < src.length && src[i + 1] === 10)) out[n++] = c;
    }
  }
  return out.subarray(0, n);
}

/**
 * git's `crlf_to_worktree`: LF turned into CRLF where the checkout writes CRLF, or the same
 * array when nothing changes.
 */
export function crlfToWorktree(
  src: Uint8Array,
  action: CrlfAction,
  settings: EolSettings,
): Uint8Array {
  if (src.length === 0 || outputEol(action, settings) !== "crlf") return src;
  const stats = gatherTextStats(src);
  if (!willConvertLfToCrlf(stats, action, settings)) return src;
  const out = new Uint8Array(src.length + stats.lonelf);
  let n = 0;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (c === 10 && !(i > 0 && src[i - 1] === 13)) out[n++] = 13;
    out[n++] = c;
  }
  return out.subarray(0, n);
}

/** Whether the index content holds CRLF that git's `has_crlf_in_index` counts. */
export function hasCrlf(content: Uint8Array | undefined): boolean {
  if (!content || content.indexOf(13) < 0) return false;
  const stats = gatherTextStats(content);
  return !isBinaryStats(stats) && stats.crlf > 0;
}
