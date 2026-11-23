/**
 * The `%(atom)` table of git's ref-filter.c: each atom's name, what it reads (the ref alone,
 * the object, or something else), how it sorts, and its argument parser with git's errors.
 *
 * @module
 */

import { RefFilterError } from "../../errors/index.js";
import { expandStringArg, matchArgValue, matchBoolArg, parseColorSpec } from "../pretty-format.js";
import type { TrailerFormatOptions } from "../trailers.js";

/** ref-filter.c's info_source: what an atom reads. */
export type AtomSource = "none" | "obj" | "other";
/** ref-filter.c's cmp_type: how a sort key compares. */
export type AtomCmpType = "str" | "ulong" | "time";

/** The atoms git knows (ref-filter.c's `valid_atom`), in its table order. */
export const ATOM_NAMES = [
  "refname",
  "objecttype",
  "objectsize",
  "objectname",
  "deltabase",
  "tree",
  "parent",
  "numparent",
  "object",
  "type",
  "tag",
  "author",
  "authorname",
  "authoremail",
  "authordate",
  "committer",
  "committername",
  "committeremail",
  "committerdate",
  "tagger",
  "taggername",
  "taggeremail",
  "taggerdate",
  "creator",
  "creatordate",
  "describe",
  "subject",
  "body",
  "trailers",
  "contents",
  "signature",
  "raw",
  "upstream",
  "push",
  "symref",
  "flag",
  "HEAD",
  "color",
  "worktreepath",
  "align",
  "end",
  "if",
  "then",
  "else",
  "rest",
  "ahead-behind",
  "is-base",
] as const;

/** An atom's kind (git's `enum atom_type`). */
export type AtomType = (typeof ATOM_NAMES)[number];

const SOURCES: Partial<Record<AtomType, AtomSource>> = {
  objecttype: "other",
  objectsize: "other",
  objectname: "other",
  deltabase: "other",
  "ahead-behind": "other",
  "is-base": "other",
};
const OBJ_ATOMS = new Set<AtomType>([
  "tree",
  "parent",
  "numparent",
  "object",
  "type",
  "tag",
  "author",
  "authorname",
  "authoremail",
  "authordate",
  "committer",
  "committername",
  "committeremail",
  "committerdate",
  "tagger",
  "taggername",
  "taggeremail",
  "taggerdate",
  "creator",
  "creatordate",
  "describe",
  "subject",
  "body",
  "trailers",
  "contents",
  "signature",
  "raw",
]);
const CMP_TYPES: Partial<Record<AtomType, AtomCmpType>> = {
  objectsize: "ulong",
  numparent: "ulong",
  authordate: "time",
  committerdate: "time",
  taggerdate: "time",
  creatordate: "time",
};

/** The source of an atom (git's `valid_atom[].source`). */
export function atomSource(type: AtomType): AtomSource {
  return SOURCES[type] ?? (OBJ_ATOMS.has(type) ? "obj" : "none");
}

/** `refname`'s options (and `symref`'s, `upstream`'s, `push`'s): ref-filter.c's refname_atom. */
export interface RefnameOption {
  option: "normal" | "short" | "lstrip" | "rstrip";
  lstrip?: number;
  rstrip?: number;
}

/** The contents options (ref-filter.c's `C_*`). */
export type ContentsOption =
  | "bare"
  | "body"
  | "body-dep"
  | "length"
  | "lines"
  | "sig"
  | "sub"
  | "sub-sanitize"
  | "trailers";

/** An atom of a format or sort key, parsed (git's `struct used_atom`). */
export interface UsedAtom {
  type: AtomType;
  /** The atom as written, `*` and arguments included */
  name: string;
  /** Dereferenced (`*name`): read from the object a tag peels to */
  deref: boolean;
  cmpType: AtomCmpType;
  source: AtomSource;
  refname?: RefnameOption;
  remote?: {
    option: "ref" | "track" | "trackshort" | "remotename" | "remoteref";
    nobracket: boolean;
    push: boolean;
    pushRemote: boolean;
  };
  contents?: {
    option: ContentsOption;
    trailers?: TrailerFormatOptions;
    lines?: number;
  };
  raw?: "bare" | "length";
  oid?: { option: "full" | "short" | "length"; length?: number };
  objectsize?: "size" | "disk";
  nameMailmap?: boolean;
  email?: { trim: boolean; localpart: boolean; mailmap: boolean };
  signature?: string;
  describe?: { tags?: boolean; abbrev?: number; match: string[]; exclude: string[] };
  color?: string;
  align?: { position: "left" | "middle" | "right"; width: number };
  ifThenElse?: { cmp: "equal" | "unequal" | "none"; str?: string };
  /** The committish of `%(ahead-behind:<x>)` / `%(is-base:<x>)` */
  base?: string;
}

/** What an atom's parser needs of the format. */
export interface AtomParseContext {
  /** Whether colors are shown (`--color`): `%(color:...)` is empty otherwise */
  useColor: boolean;
}

const fatal = (message: string) => new RefFilterError(`fatal: ${message}`, 128);

function atomPrefix(name: string): string {
  const colon = name.indexOf(":");
  return colon >= 0 ? name.slice(0, colon) : name;
}

const errNoArg = (name: string) => fatal(`%(${atomPrefix(name)}) does not take arguments`);
const errBadArg = (name: string, arg: string) =>
  fatal(`unrecognized %(${atomPrefix(name)}) argument: ${arg}`);

/** strtol_i: a whole decimal int, else undefined. */
function strtolI(text: string): number | undefined {
  if (!/^[ \t\n\v\f\r]*[+-]?\d+$/.test(text)) return undefined;
  const n = Number.parseInt(text.trim(), 10);
  return n >= -2147483648 && n <= 2147483647 ? n : undefined;
}

/** strtoul_ui: a whole unsigned decimal (git takes no sign), else undefined. */
function strtoulUi(text: string): number | undefined {
  if (!/^[ \t\n\v\f\r]*\+?\d+$/.test(text)) return undefined;
  const n = Number.parseInt(text.trim(), 10);
  return n <= 0xffffffff ? n : undefined;
}

function parseRefnameOption(arg: string | undefined, name: string): RefnameOption {
  if (arg === undefined) return { option: "normal" };
  if (arg === "short") return { option: "short" };
  const l = /^(?:lstrip|strip)=(.*)$/s.exec(arg);
  if (l) {
    const n = strtolI(l[1] as string);
    if (n === undefined) throw fatal(`Integer value expected refname:lstrip=${l[1]}`);
    return { option: "lstrip", lstrip: n };
  }
  const r = /^rstrip=(.*)$/s.exec(arg);
  if (r) {
    const n = strtolI(r[1] as string);
    if (n === undefined) throw fatal(`Integer value expected refname:rstrip=${r[1]}`);
    return { option: "rstrip", rstrip: n };
  }
  throw errBadArg(name, arg);
}

/**
 * ref-filter.c's match_atom_arg_value: `candidate` or `candidate=value` at the start of
 * `text` (values end at the next comma); the rest after the comma.
 */
function matchAtomArgValue(
  text: string,
  candidate: string,
): { value: string | undefined; rest: string } | undefined {
  if (!text.startsWith(candidate)) return undefined;
  const after = text.slice(candidate.length);
  let value: string | undefined;
  let tail: string;
  if (after.startsWith("=")) {
    const comma = after.indexOf(",", 1);
    value = comma >= 0 ? after.slice(1, comma) : after.slice(1);
    tail = comma >= 0 ? after.slice(comma) : "";
  } else if (after !== "" && !after.startsWith(",")) return undefined;
  else tail = after;
  return { value, rest: tail.startsWith(",") ? tail.slice(1) : tail };
}

function parseBoolValue(value: string): boolean | undefined {
  const v = value.toLowerCase();
  if (v === "true" || v === "yes" || v === "on") return true;
  if (v === "false" || v === "no" || v === "off" || v === "") return false;
  const n = /^([+-]?\d+)([kmg]?)$/.exec(v);
  return n ? Number(n[1]) !== 0 : undefined;
}

/** format_set_trailers_options over `arg` (git appends the `)` the atom ended with). */
function parseTrailersOptions(arg: string): TrailerFormatOptions {
  const fmt = `${arg})`;
  const options: TrailerFormatOptions & { keys?: string[] } = {};
  let i = 0;
  for (;;) {
    if (fmt[i] === ")") break;
    const key = matchArgValue(fmt, i, "key");
    if (key) {
      if (key.value === undefined) throw fatal("expected %(trailers:key=<value>)");
      options.keys = [...(options.keys ?? []), key.value];
      options.onlyTrailers = true;
      i = key.end;
      continue;
    }
    const separator = matchArgValue(fmt, i, "separator");
    if (separator) {
      options.separator = expandStringArg(separator.value ?? "");
      i = separator.end;
      continue;
    }
    const kv = matchArgValue(fmt, i, "key_value_separator");
    if (kv) {
      options.keyValueSeparator = expandStringArg(kv.value ?? "");
      i = kv.end;
      continue;
    }
    const flag = (
      [
        ["only", "onlyTrailers"],
        ["unfold", "unfold"],
        ["keyonly", "keyOnly"],
        ["valueonly", "valueOnly"],
      ] as const
    ).find(([n]) => matchBoolArg(fmt, i, n));
    if (!flag) {
      const rest = fmt.slice(i);
      const end = rest.search(/[,)]/);
      throw fatal(`unknown %(trailers) argument: ${end >= 0 ? rest.slice(0, end) : rest}`);
    }
    const parsed = matchBoolArg(fmt, i, flag[0]) as { value: boolean; end: number };
    options[flag[1]] = parsed.value;
    i = parsed.end;
  }
  return options;
}

function parseAlign(arg: string | undefined): NonNullable<UsedAtom["align"]> {
  if (arg === undefined) throw fatal("expected format: %(align:<width>,<position>)");
  const positionOf = (s: string) =>
    s === "right" || s === "middle" || s === "left" ? s : undefined;
  let position: "left" | "middle" | "right" = "left";
  let width: number | undefined;
  for (const s of arg.split(",")) {
    if (s.startsWith("position=")) {
      const p = positionOf(s.slice(9));
      if (!p) throw fatal(`unrecognized position:${s.slice(9)}`);
      position = p;
    } else if (s.startsWith("width=")) {
      const w = strtoulUi(s.slice(6));
      if (w === undefined) throw fatal(`unrecognized width:${s.slice(6)}`);
      width = w;
    } else if (strtoulUi(s) !== undefined) {
      width = strtoulUi(s);
    } else if (positionOf(s)) position = positionOf(s) as typeof position;
    else throw fatal(`unrecognized %(align) argument: ${s}`);
  }
  if (width === undefined || width === 0xffffffff) {
    throw fatal("positive width expected with the %(align) atom");
  }
  return { position, width };
}

function parseDescribe(arg: string | undefined): NonNullable<UsedAtom["describe"]> {
  const out: NonNullable<UsedAtom["describe"]> = { match: [], exclude: [] };
  let rest = arg ?? "";
  while (rest !== "") {
    const bad = rest;
    const tags = matchAtomArgValue(rest, "tags");
    if (tags && (tags.value === undefined || parseBoolValue(tags.value) !== undefined)) {
      out.tags = tags.value === undefined ? true : (parseBoolValue(tags.value) as boolean);
      rest = tags.rest;
      continue;
    }
    const abbrev = matchAtomArgValue(rest, "abbrev");
    if (abbrev) {
      const v = abbrev.value ?? "";
      if (!v) throw fatal("argument expected for describe:abbrev");
      const lead = /^[ \t\n\v\f\r]*[+-]?\d*/.exec(v)?.[0] ?? "";
      const n = Number.parseInt(lead.trim(), 10);
      if (n < 0) throw fatal(`positive value expected describe:abbrev=${v}`);
      if (lead.length !== v.length || !/\d/.test(lead)) {
        throw fatal(`cannot fully parse describe:abbrev=${v}`);
      }
      out.abbrev = n;
      rest = abbrev.rest;
      continue;
    }
    const match = matchAtomArgValue(rest, "match");
    if (match) {
      if (!match.value) throw fatal("value expected describe:match=");
      out.match.push(match.value);
      rest = match.rest;
      continue;
    }
    const exclude = matchAtomArgValue(rest, "exclude");
    if (exclude) {
      if (!exclude.value) throw fatal("value expected describe:exclude=");
      out.exclude.push(exclude.value);
      rest = exclude.rest;
      continue;
    }
    throw errBadArg("describe", bad);
  }
  return out;
}

/**
 * ref-filter.c's parse_ref_filter_atom for one atom (`text` is what stands between `%(` and
 * `)`, the `*` included): the atom, or git's die message as a {@link RefFilterError}.
 */
export function parseAtom(text: string, context: AtomParseContext): UsedAtom {
  const deref = text.startsWith("*");
  const sp = deref ? text.slice(1) : text;
  if (sp === "") throw fatal(`malformed field name: ${text}`);
  const colon = sp.indexOf(":");
  const atomName = colon >= 0 ? sp.slice(0, colon) : sp;
  const type = (ATOM_NAMES as readonly string[]).includes(atomName)
    ? (atomName as AtomType)
    : undefined;
  if (!type) throw fatal(`unknown field name: ${text}`);
  // "%(atom:)" is "%(atom)"
  let arg = colon >= 0 ? sp.slice(colon + 1) : undefined;
  if (arg === "") arg = undefined;
  const atom: UsedAtom = {
    type,
    name: text,
    deref,
    cmpType: CMP_TYPES[type] ?? "str",
    source: atomSource(type),
  };
  switch (type) {
    case "refname":
    case "symref":
      atom.refname = parseRefnameOption(arg, text);
      break;
    case "upstream":
    case "push": {
      const push = type === "push";
      atom.remote = { option: "ref", nobracket: false, push, pushRemote: false };
      if (arg === undefined) {
        atom.refname = { option: "normal" };
        break;
      }
      atom.refname = { option: "normal" };
      for (const s of arg.split(",")) {
        if (s === "track") atom.remote.option = "track";
        else if (s === "trackshort") atom.remote.option = "trackshort";
        else if (s === "nobracket") atom.remote.nobracket = true;
        else if (s === "remotename") {
          atom.remote.option = "remotename";
          atom.remote.pushRemote = true;
        } else if (s === "remoteref") {
          atom.remote.option = "remoteref";
          atom.remote.pushRemote = true;
        } else {
          atom.remote.option = "ref";
          // git parses the whole argument, not the item
          atom.refname = parseRefnameOption(arg, text);
        }
      }
      break;
    }
    case "objecttype":
      if (arg !== undefined) throw errNoArg("objecttype");
      break;
    case "objectsize":
      if (arg === undefined) atom.objectsize = "size";
      else if (arg === "disk") atom.objectsize = "disk";
      else throw errBadArg("objectsize", arg);
      break;
    case "deltabase":
      if (arg !== undefined) throw errNoArg("deltabase");
      break;
    case "body":
      if (arg !== undefined) throw errNoArg("body");
      atom.contents = { option: "body-dep" };
      break;
    case "subject":
      if (arg === undefined) atom.contents = { option: "sub" };
      else if (arg === "sanitize") atom.contents = { option: "sub-sanitize" };
      else throw errBadArg("subject", arg);
      break;
    case "signature": {
      const options = [
        "signer",
        "grade",
        "key",
        "fingerprint",
        "primarykeyfingerprint",
        "trustlevel",
      ];
      if (arg !== undefined && !options.includes(arg)) throw errBadArg("signature", arg);
      atom.signature = arg ?? "";
      break;
    }
    case "trailers":
      atom.contents = {
        option: "trailers",
        trailers: arg === undefined ? {} : parseTrailersOptions(arg),
      };
      break;
    case "contents":
      if (arg === undefined) atom.contents = { option: "bare" };
      else if (arg === "body") atom.contents = { option: "body" };
      else if (arg === "size") {
        atom.cmpType = "ulong";
        atom.contents = { option: "length" };
      } else if (arg === "signature") atom.contents = { option: "sig" };
      else if (arg === "subject") atom.contents = { option: "sub" };
      else if (arg === "trailers") atom.contents = { option: "trailers", trailers: {} };
      else if (arg.startsWith("trailers:")) {
        atom.contents = { option: "trailers", trailers: parseTrailersOptions(arg.slice(9)) };
      } else if (arg.startsWith("lines=")) {
        const n = strtoulUi(arg.slice(6));
        if (n === undefined) throw fatal(`positive value expected contents:lines=${arg.slice(6)}`);
        atom.contents = { option: "lines", lines: n };
      } else throw errBadArg("contents", arg);
      break;
    case "describe":
      atom.describe = parseDescribe(arg);
      break;
    case "raw":
      if (arg === undefined) atom.raw = "bare";
      else if (arg === "size") {
        atom.cmpType = "ulong";
        atom.raw = "length";
      } else throw errBadArg("raw", arg);
      break;
    case "objectname":
    case "tree":
    case "parent":
      if (arg === undefined) atom.oid = { option: "full" };
      else if (arg === "short") atom.oid = { option: "short" };
      else if (arg.startsWith("short=")) {
        const n = strtoulUi(arg.slice(6));
        if (n === undefined || n === 0) {
          throw fatal(`positive value expected '${arg.slice(6)}' in %(${text})`);
        }
        atom.oid = { option: "length", length: Math.max(n, 4) };
      } else throw errBadArg(text, arg);
      break;
    case "authorname":
    case "committername":
    case "taggername":
      if (arg === undefined) atom.nameMailmap = false;
      else if (arg === "mailmap") atom.nameMailmap = true;
      else throw errBadArg(text, arg);
      break;
    case "authoremail":
    case "committeremail":
    case "taggeremail": {
      const email = { trim: false, localpart: false, mailmap: false };
      let rest = arg;
      for (;;) {
        if (rest === undefined) break;
        const bad = rest;
        if (rest.startsWith("trim")) {
          email.trim = true;
          rest = rest.slice(4);
        } else if (rest.startsWith("localpart")) {
          email.localpart = true;
          rest = rest.slice(9);
        } else if (rest.startsWith("mailmap")) {
          email.mailmap = true;
          rest = rest.slice(7);
        } else throw errBadArg(text, bad);
        if (rest === "") break;
        if (rest.startsWith(",")) rest = rest.slice(1);
        else throw errBadArg(text, rest);
      }
      atom.email = email;
      break;
    }
    case "align":
      atom.align = parseAlign(arg);
      break;
    case "if":
      if (arg === undefined) atom.ifThenElse = { cmp: "none" };
      else if (arg.startsWith("equals=")) atom.ifThenElse = { cmp: "equal", str: arg.slice(7) };
      else if (arg.startsWith("notequals=")) {
        atom.ifThenElse = { cmp: "unequal", str: arg.slice(10) };
      } else throw errBadArg("if", arg);
      break;
    case "rest":
      if (arg !== undefined) throw errNoArg("rest");
      break;
    case "HEAD":
      if (arg !== undefined) throw errNoArg("HEAD");
      break;
    case "color": {
      if (arg === undefined) throw fatal("expected format: %(color:<color>)");
      let color: string;
      try {
        color = parseColorSpec(arg);
      } catch {
        throw new RefFilterError(
          `error: invalid color value: ${arg}\nfatal: unrecognized color: %(color:${arg})`,
          128,
        );
      }
      atom.color = context.useColor ? color : "";
      break;
    }
    case "ahead-behind":
      if (arg === undefined) throw fatal("expected format: %(ahead-behind:<committish>)");
      atom.base = arg;
      break;
    case "is-base":
      if (arg === undefined) throw fatal("expected format: %(is-base:<committish>)");
      atom.base = arg;
      break;
    default:
      // atoms without a parser take any argument
      break;
  }
  return atom;
}
