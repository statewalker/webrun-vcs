/**
 * cat-file's `--batch` format (builtin/cat-file.c `expand_format`/`expand_atom`): the atoms
 * a format names, checked once before any input is read (git's `mark_query` pass), then
 * expanded per object.
 */

import { PlumbingError } from "../plumbing-command.js";

/** What one object expands with. */
export interface BatchObjectData {
  id: string;
  type?: string;
  size?: number;
  /** The tree or index entry's mode (`<rev>:<path>`), undefined otherwise */
  mode?: number;
  /** `%(rest)`: the input line after the object name and its whitespace */
  rest?: string;
}

type Part = string | { atom: "objectname" | "objecttype" | "objectsize" | "rest" | "objectmode" };

/** A parsed format and what it needs read. */
export interface BatchFormat {
  parts: Part[];
  /** `%(objecttype)` (or contents) needs the type */
  needsType: boolean;
  needsSize: boolean;
  /** `%(rest)`: input lines are split at their first whitespace */
  splitOnWhitespace: boolean;
}

/** The default format, `%(objectname) %(objecttype) %(objectsize)`. */
export const DEFAULT_BATCH_FORMAT = "%(objectname) %(objecttype) %(objectsize)";

/**
 * Parses `format` as git's mark_query pass reads it: an atom git does not know dies there
 * (2.43 `unknown format element: <atom>`, 2.5x `bad cat-file format: %(<atom>)`).
 * `%(objectsize:disk)` and `%(deltabase)` are refused: the stores do not report on-disk sizes
 * or delta bases, and printing a made-up value would lie.
 */
export function parseBatchFormat(format: string, compatibility: "2.43" | "2.56"): BatchFormat {
  const parts: Part[] = [];
  const result: BatchFormat = {
    parts,
    needsType: false,
    needsSize: false,
    splitOnWhitespace: false,
  };
  let literal = "";
  let at = 0;
  for (;;) {
    const percent = format.indexOf("%", at);
    if (percent < 0) {
      literal += format.slice(at);
      break;
    }
    literal += format.slice(at, percent);
    at = percent + 1;
    // strbuf_expand_step: "%%" is a percent; a "%" not before "(" is kept as is
    if (format[at] === "%") {
      literal += "%";
      at++;
      continue;
    }
    if (format[at] !== "(") {
      literal += "%";
      continue;
    }
    const end = format.indexOf(")", at + 1);
    if (end < 0) {
      const rest = format.slice(at);
      throw new PlumbingError(
        compatibility === "2.43"
          ? `fatal: format element '${rest}' does not end in ')'`
          : `fatal: bad cat-file format: element '${rest}' does not end in ')'`,
      );
    }
    const atom = format.slice(at + 1, end);
    switch (atom) {
      case "objectname":
        break;
      case "objecttype":
        result.needsType = true;
        break;
      case "objectsize":
        result.needsSize = true;
        break;
      case "rest":
        result.splitOnWhitespace = true;
        break;
      case "objectmode":
        if (compatibility === "2.43") throw unknownAtom(atom, compatibility);
        break;
      case "objectsize:disk":
      case "deltabase":
        throw new PlumbingError(`fatal: cat-file: %(${atom}) is not supported`);
      default:
        throw unknownAtom(atom, compatibility);
    }
    if (literal) parts.push(literal);
    literal = "";
    parts.push({ atom: atom as "objectname" });
    at = end + 1;
  }
  if (literal) parts.push(literal);
  return result;
}

function unknownAtom(atom: string, compatibility: "2.43" | "2.56"): PlumbingError {
  return new PlumbingError(
    compatibility === "2.43"
      ? `fatal: unknown format element: ${atom}`
      : `fatal: bad cat-file format: %(${atom})`,
  );
}

/** The format expanded for one object. */
export function expandBatchFormat(format: BatchFormat, data: BatchObjectData): string {
  let out = "";
  for (const part of format.parts) {
    if (typeof part === "string") {
      out += part;
      continue;
    }
    switch (part.atom) {
      case "objectname":
        out += data.id;
        break;
      case "objecttype":
        out += data.type ?? "";
        break;
      case "objectsize":
        out += String(data.size ?? 0);
        break;
      case "rest":
        out += data.rest ?? "";
        break;
      case "objectmode":
        if (data.mode !== undefined) out += data.mode.toString(8).padStart(6, "0");
        break;
    }
  }
  return out;
}
