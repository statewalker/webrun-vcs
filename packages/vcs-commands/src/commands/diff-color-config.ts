/**
 * The color settings of `git diff`, `log` and `show` as git reads them: `color.ui`,
 * `color.diff` (`diff.color`), `color.diff.<slot>` (`diff.color.<slot>`), `diff.colorMoved`,
 * `diff.colorMovedWS`, `diff.wsErrorHighlight`, `color.decorate.<slot>`, then the command
 * line's `--color`, `--color-moved`, `--color-moved-ws` and `--ws-error-highlight`.
 *
 * @example
 * ```typescript
 * const settings = readDiffColorSettings(workingCopy, { color: true, colorMoved: "zebra" });
 * // settings.colors: the palette; settings.colorMoved: "zebra"
 * ```
 *
 * The configuration is read in its order, as git's config callbacks see it, and a value
 * git refuses dies as git dies (`error: invalid color value: <v>`, then where it was read).
 * Without a terminal `auto` means no color: only `always` (or `--color`) colors.
 *
 * @module
 */

import type { WorkingCopy } from "@statewalker/vcs-working-tree";

import { GitApiError, InvalidArgumentError, InvalidConfigError } from "../errors/index.js";
import { RemoteConfigStore } from "../remote-config/index.js";
import {
  COLOR_MOVED_MODE_ERROR,
  type ColorMovedMode,
  DEFAULT_DIFF_COLORS,
  type DiffColors,
  diffColorSlotOf,
  parseColorMoved,
  parseColorMovedWs,
  parseWsErrorHighlight,
  WSEH_NEW,
  wsErrorHighlightOf,
} from "../results/diff-color.js";
import { WORD_DIFF_MODES } from "../results/diff-words.js";
import { parseGitColor } from "./config-value-types.js";

/** The decoration slots of `color.decorate.<slot>` (log-tree.c's `color_decorate_slots`) */
export interface DecorationColors {
  branch: string;
  remoteBranch: string;
  tag: string;
  stash: string;
  HEAD: string;
  grafted: string;
  reset: string;
}

/** log-tree.c's `decoration_colors` */
export const DEFAULT_DECORATION_COLORS: Readonly<DecorationColors> = Object.freeze({
  reset: "\x1b[m",
  branch: "\x1b[1;32m",
  remoteBranch: "\x1b[1;31m",
  tag: "\x1b[1;33m",
  stash: "\x1b[1;35m",
  HEAD: "\x1b[1;36m",
  grafted: "\x1b[1;34m",
});

/** What the command line says about colors (each unset: the configuration's) */
export interface DiffColorOptions {
  /** `--color[=always|never|auto]` (true is `always`), `--no-color` (false) */
  color?: boolean | "always" | "never" | "auto";
  /**
   * `--color-moved[=<mode>]`: true is `--color-moved` alone (`diff.colorMoved` when it names
   * a mode, else `zebra`), false `--no-color-moved`; a mode git does not know throws git's
   * two lines (exit 129)
   */
  colorMoved?: boolean | string;
  /** `--color-moved-ws=<modes>`, false `--no-color-moved-ws` */
  colorMovedWs?: string | false;
  /** `--ws-error-highlight=<kinds>` */
  wsErrorHighlight?: string;
  /** 2.43 knows no `#rgb` colors (default 2.56) */
  colorCompatibility?: "2.43" | "2.56";
}

/** The colors a diff (and a log) prints with */
export interface DiffColorSettings {
  /** The palette, or undefined for no color */
  colors?: DiffColors;
  /** The decorations' palette (with `colors` only) */
  decorationColors?: DecorationColors;
  colorMoved: ColorMovedMode;
  colorMovedWs: number;
  wsErrorHighlight: number;
}

/** Where a variable was read, as git names it when it dies */
function where(key: string, file: string | undefined, line: number | undefined): string {
  return file !== undefined && line !== undefined
    ? `fatal: bad config variable '${key}' in file '${file}' at line ${line}`
    : `fatal: unable to parse '${key}' from command-line config`;
}

/** color.c's `git_config_colorbool` (`undefined` for git's unknown) */
function colorBool(key: string, value: string | undefined): "never" | "always" | "auto" {
  if (value !== undefined) {
    const lower = value.toLowerCase();
    if (lower === "never" || lower === "always" || lower === "auto") return lower;
  }
  if (value === undefined) return "auto";
  const v = value.toLowerCase();
  if (v === "" || v === "false" || v === "no" || v === "off") return "never";
  if (v === "true" || v === "yes" || v === "on") return "auto";
  if (/^[-+]?\d+$/.test(v)) return Number(v) !== 0 ? "auto" : "never";
  throw new InvalidConfigError(key, `fatal: bad boolean config value '${value}' for '${key}'`);
}

const DECORATION_SLOTS: (keyof DecorationColors)[] = [
  "branch",
  "remoteBranch",
  "tag",
  "stash",
  "HEAD",
  "grafted",
];

/**
 * The color settings of a porcelain diff (`git_diff_ui_config` when `uiConfig`, else only
 * the slots of `git_diff_basic_config`), then the command line's.
 *
 * @throws InvalidConfigError for a value git refuses in the configuration (exit 128)
 * @throws InvalidArgumentError for an option git refuses (exit 129)
 */
export function readDiffColorSettings(
  workingCopy: WorkingCopy,
  options: DiffColorOptions & { wordDiff?: string },
  uiConfig = true,
): DiffColorSettings {
  // diff_opt_word_diff: an unknown mode dies while the options are parsed
  if (
    options.wordDiff !== undefined &&
    !(WORD_DIFF_MODES as readonly string[]).includes(options.wordDiff)
  ) {
    throw new InvalidArgumentError(
      "wordDiff",
      options.wordDiff,
      `error: bad --word-diff argument: ${options.wordDiff}`,
    ).withExitCode(129);
  }
  const compatibility = options.colorCompatibility ?? "2.56";
  const colors: DiffColors = { ...DEFAULT_DIFF_COLORS };
  const decorationColors: DecorationColors = { ...DEFAULT_DECORATION_COLORS };
  let ui: "never" | "always" | "auto" | undefined;
  let diff: "never" | "always" | "auto" | undefined;
  let colorMoved: ColorMovedMode = "no";
  let colorMovedWs = 0;
  let wsErrorHighlight = WSEH_NEW;
  const entries = workingCopy.config
    ? (RemoteConfigStore.from(workingCopy).allEntriesWithOrigin() ?? [])
    : [];
  for (const { key, text, file, line } of entries) {
    const missing = () =>
      new InvalidConfigError(key, `error: missing value for '${key}'\n${where(key, file, line)}`);
    if (key === "color.ui") {
      if (uiConfig) ui = colorBool(key, text);
    } else if (key === "diff.color" || key === "color.diff") {
      if (uiConfig) diff = colorBool(key, text);
    } else if (key === "diff.colormoved") {
      if (!uiConfig) continue;
      const mode = parseColorMoved(text);
      if (mode === undefined) {
        throw new InvalidConfigError(key, `${COLOR_MOVED_MODE_ERROR}\n${where(key, file, line)}`);
      }
      colorMoved = mode;
    } else if (key === "diff.colormovedws") {
      if (!uiConfig) continue;
      if (text === undefined) throw missing();
      const parsed = parseColorMovedWs(text);
      if (parsed.errors.length > 0) {
        throw new InvalidConfigError(key, `${parsed.errors.join("\n")}\n${where(key, file, line)}`);
      }
      colorMovedWs = parsed.flags;
    } else if (key === "diff.wserrorhighlight") {
      if (text === undefined) throw missing();
      const val = parseWsErrorHighlight(text);
      if (val === undefined) {
        throw new InvalidConfigError(
          key,
          `error: unknown value for config '${key}': ${text}\n${where(key, file, line)}`,
        );
      }
      wsErrorHighlight = val;
    } else if (key.startsWith("diff.color.") || key.startsWith("color.diff.")) {
      const slot = diffColorSlotOf(key.slice(11));
      if (!slot) continue;
      if (text === undefined) throw missing();
      const color = parseGitColor(text, compatibility);
      if (color === undefined) {
        throw new InvalidConfigError(
          key,
          `error: invalid color value: ${text}\n${where(key, file, line)}`,
        );
      }
      colors[slot] = color;
    } else if (key.startsWith("color.decorate.")) {
      const name = key.slice(15);
      const slot = DECORATION_SLOTS.find((s) => s.toLowerCase() === name);
      if (!slot) continue;
      if (text === undefined) throw missing();
      const color = parseGitColor(text, compatibility);
      if (color === undefined) {
        throw new InvalidConfigError(
          key,
          `error: invalid color value: ${text}\n${where(key, file, line)}`,
        );
      }
      decorationColors[slot] = color;
    }
  }

  // the command line
  let want: "never" | "always" | "auto" = diff ?? ui ?? "auto";
  // `--word-diff=color` and `--color-words` turn colors on (a `color` given wins, as if after)
  if (options.wordDiff === "color") want = "always";
  if (options.color !== undefined) {
    want = options.color === true ? "always" : options.color === false ? "never" : options.color;
  }
  if (options.colorMoved !== undefined) {
    if (options.colorMoved === false) colorMoved = "no";
    else if (options.colorMoved === true) {
      if (colorMoved === "no") colorMoved = "zebra";
    } else {
      const mode = parseColorMoved(options.colorMoved);
      if (mode === undefined) {
        throw new InvalidArgumentError(
          "colorMoved",
          options.colorMoved,
          `${COLOR_MOVED_MODE_ERROR}\nerror: bad --color-moved argument: ${options.colorMoved}`,
        ).withExitCode(129);
      }
      colorMoved = mode;
    }
  }
  if (options.colorMovedWs !== undefined) {
    if (options.colorMovedWs === false) colorMovedWs = 0;
    else {
      const parsed = parseColorMovedWs(options.colorMovedWs);
      if (parsed.errors.length > 0) {
        throw new InvalidArgumentError(
          "colorMovedWs",
          options.colorMovedWs,
          `${parsed.errors.join("\n")}\nerror: invalid mode '${options.colorMovedWs}' in --color-moved-ws`,
        ).withExitCode(129);
      }
      colorMovedWs = parsed.flags;
    }
  }
  if (options.wsErrorHighlight !== undefined) {
    const val = wsErrorHighlightOf(options.wsErrorHighlight);
    if (typeof val !== "number") {
      throw new InvalidArgumentError(
        "wsErrorHighlight",
        options.wsErrorHighlight,
        `error: unknown value after ws-error-highlight=${val.badPrefix}`,
      ).withExitCode(129);
    }
    wsErrorHighlight = val;
  }
  const on = want === "always";
  return {
    ...(on ? { colors, decorationColors } : {}),
    colorMoved,
    colorMovedWs,
    wsErrorHighlight,
  };
}

/** Throws git's death for a `core.whitespace` git refuses */
export function whitespaceRuleError(message: string): GitApiError {
  return new GitApiError(`fatal: ${message}`);
}
