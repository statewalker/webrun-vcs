/**
 * The format language of git's ref-filter.c: a format's atoms parsed once, each ref's values
 * computed when first needed (its object read only if an atom needs it), and the format
 * expanded with `%(if)`/`%(then)`/`%(else)`, `%(align)` and the quoting styles, byte for byte
 * as `git for-each-ref --format` prints it.
 *
 * Values are text as vcs-utils' `decodeGitPath` gives bytes (UTF-8, other bytes as U+DC80 +
 * byte), so `encodeGitPath` of the output is git's bytes.
 *
 * @example
 * ```typescript
 * const format = new RefFormat("%(refname:short) %(objectname:short)", source);
 * const line = await format.format(item); // "main 1a2b3c4"
 * ```
 *
 * @module
 */

import type { ObjectId } from "@statewalker/vcs-core";
import { decodeGitPath, encodeGitPath, gitStrWidth } from "@statewalker/vcs-utils";

import { RefFilterError } from "../../errors/index.js";
import { type DateMode, parseDateMode, type ShowDateContext, showDate } from "../date-format.js";
import type { Mailmap } from "../mailmap.js";
import { sanitizedSubject } from "../pretty-format.js";
import { appendTrailers, type TrailerConfig } from "../trailers.js";
import { type AtomCmpType, parseAtom, type UsedAtom } from "./ref-atoms.js";
import { quoteRefValue, type RefQuoteStyle } from "./ref-quote.js";

/** The kinds of refs (ref-filter.h's `FILTER_REFS_*`). */
export const RefKind = {
  TAGS: 0x0002,
  BRANCHES: 0x0004,
  REMOTES: 0x0008,
  OTHERS: 0x0010,
  REGULAR: 0x001e,
  DETACHED_HEAD: 0x0020,
  PSEUDOREFS: 0x0040,
  ROOT_REFS: 0x0080,
} as const;

/** A ref the filter kept (git's `struct ref_array_item`). */
export interface RefFilterItem {
  /** The full name (`refs/heads/main`, `HEAD`) */
  refname: string;
  /** The object it names (a symbolic ref's target's) */
  objectId: ObjectId;
  /** What it peels to, when the ref store knows (packed-refs `^` lines) */
  peeledId?: ObjectId;
  /** A symbolic ref's target */
  symref?: string;
  /** git's REF_ISSYMREF / REF_ISPACKED */
  flags: { symref: boolean; packed: boolean };
  /** Its {@link RefKind} */
  kind: number;
  /** The commit it peels to, when a reachability filter asked for it */
  commit?: ObjectId;
  /** `%(rest)`'s text (none for for-each-ref) */
  rest?: string;
  /** `%(ahead-behind:...)` counts, one per such atom, for a ref that peels to a commit */
  counts?: { ahead: number; behind: number }[];
  /** `%(is-base:...)` names, one per such atom */
  isBase?: (string | undefined)[];
  /** The values of the format's atoms, once computed */
  values?: AtomValue[];
}

/** A computed atom value (git's `struct atom_value`). */
export interface AtomValue {
  s: string;
  /** The value has a length of its own (`%(raw)`: NULs kept) */
  sized?: boolean;
  /** The number sorted on for numeric and date atoms */
  value: number;
  atom: UsedAtom;
}

/** An object as the format reads it. */
export interface RefFormatObject {
  type: "commit" | "tree" | "blob" | "tag";
  bytes: Uint8Array;
}

/** What the format reads of the repository; see {@link RefFormat}. */
export interface RefFormatSource {
  /** The object (its replacement when a replace ref names one), undefined when missing */
  readObject(id: ObjectId): Promise<RefFormatObject | undefined>;
  /** `id` abbreviated as git prints it: its default length, or at least `minLength` */
  abbreviate(id: ObjectId, minLength?: number): Promise<string>;
  /** Whether a ref of this full name exists */
  refExists(name: string): Promise<boolean>;
  /** A configuration value (the last one) */
  config(key: string): string | undefined;
  /** The ref HEAD resolves to (`HEAD` when detached), undefined when unborn */
  headRef(): Promise<string | undefined>;
  /** `branch@{upstream}`'s full ref name, undefined when none */
  upstreamOf(branch: string): Promise<string | undefined>;
  /** `branch@{push}`'s full ref name, undefined when none */
  pushOf(branch: string): Promise<string | undefined>;
  /** `remote_for_branch` / `pushremote_for_branch` when configured (explicit), else "" */
  remoteName(branch: string, push: boolean): string;
  /** `remote_ref_for_branch`: the merge source, or the push refspec's destination */
  remoteRef(branch: string, push: boolean): string | undefined;
  /** The commit a ref names (tags peeled), undefined when it names none */
  refCommit(ref: string): Promise<ObjectId | undefined>;
  /** The commits only `ours` and only `theirs` reach */
  aheadBehind(ours: ObjectId, theirs: ObjectId): Promise<{ ahead: number; behind: number }>;
  /** The worktree a branch is checked out in, undefined when none */
  worktreePath(ref: string): Promise<string | undefined>;
  /** The repository's mailmap */
  mailmap(): Promise<Mailmap>;
  /** `git describe <args> <id>`'s output, "" when it fails */
  describe(id: ObjectId, options: NonNullable<UsedAtom["describe"]>): Promise<string>;
  /** The trailer configuration */
  trailerConfig(): TrailerConfig;
  /** get_head_description: `(HEAD detached at ...)` for a detached HEAD listed as such */
  headDescription?(): Promise<string>;
  /** The clock and local zone dates are shown with */
  dateContext?: ShowDateContext;
}

/** How {@link RefFormat} expands its format. */
export interface RefFormatOptions {
  /** `--shell`, `--perl`, `--python`, `--tcl` */
  quoteStyle?: RefQuoteStyle;
  /** `--color`: `%(color:...)` atoms give their escapes */
  useColor?: boolean;
  /**
   * The git version whose output to follow where versions differ (default 2.56). git 2.43's
   * `%(*atom)` reads the object a tag names (a tag of a tag shows the inner tag), not what
   * nested tags peel to, and its `%(trailers)` look for the trailer block in the message with
   * its signature (a signed tag's trailers are not found), and a date atom with a format
   * still sorts by time.
   */
  compatibility?: "2.43" | "2.56";
}

const fatal = (message: string) => new RefFilterError(`fatal: ${message}`, 128);

/** The ref name rules `shorten_unambiguous_ref` walks (git's ref_rev_parse_rules). */
const RULES = [
  "%s",
  "refs/%s",
  "refs/tags/%s",
  "refs/heads/%s",
  "refs/remotes/%s",
  "refs/remotes/%s/HEAD",
];

/**
 * refs.c's `refs_shorten_unambiguous_ref`: the shortest name a rule maps back to `ref`
 * that no other rule (strict: any; else only the earlier ones) resolves to an existing ref.
 */
export async function shortenRefName(
  ref: string,
  strict: boolean,
  exists: (name: string) => Promise<boolean>,
): Promise<string> {
  for (let i = RULES.length - 1; i > 0; i--) {
    const [prefix, suffix] = (RULES[i] as string).split("%s") as [string, string];
    if (ref.length <= prefix.length + suffix.length) continue;
    if (!ref.startsWith(prefix) || !ref.endsWith(suffix)) continue;
    const short = ref.slice(prefix.length, ref.length - suffix.length);
    const toFail = strict ? RULES.length : i;
    let ambiguous = false;
    for (let j = 0; j < toFail && !ambiguous; j++) {
      if (j === i) continue;
      if (await exists((RULES[j] as string).replace("%s", short))) ambiguous = true;
    }
    if (!ambiguous) return short;
  }
  return ref;
}

function slashes(name: string): number {
  let n = 0;
  for (const c of name) if (c === "/") n++;
  return n;
}

/** normalize_component_count. */
const componentCount = (name: string, len: number) => (len < 0 ? slashes(name) + len + 1 : len);

/** lstrip_ref_components. */
export function lstripRef(name: string, len: number): string {
  let remaining = componentCount(name, len);
  let i = 0;
  while (remaining > 0) {
    if (i >= name.length) return "";
    if (name[i++] === "/") remaining--;
  }
  return name.slice(i);
}

/** rstrip_ref_components. */
export function rstripRef(name: string, len: number): string {
  let remaining = componentCount(name, len);
  let end = name.length;
  while (remaining > 0) {
    if (end === 0) return "";
    if (name[--end] === "/") remaining--;
  }
  return name.slice(0, end);
}

const isSpace = (c: string) =>
  c === " " || c === "\t" || c === "\n" || c === "\v" || c === "\f" || c === "\r";

/** The offset of a trailing signature (gpg-interface.c's parse_signed_buffer). */
function signatureStart(text: string): number {
  const sigs = [
    "-----BEGIN PGP SIGNATURE-----",
    "-----BEGIN PGP MESSAGE-----",
    "-----BEGIN SIGNED MESSAGE-----",
    "-----BEGIN SSH SIGNATURE-----",
  ];
  let match = text.length;
  let at = 0;
  while (at < text.length) {
    if (sigs.some((s) => text.startsWith(s, at))) match = at;
    const eol = text.indexOf("\n", at);
    at = eol >= 0 ? eol + 1 : text.length;
  }
  return match;
}

interface SubPos {
  sub: number;
  sublen: number;
  body: number;
  nonsiglen: number;
  sig: number;
  buf: string;
}

/** ref-filter.c's find_subpos over an object's text (up to its first NUL, a C string). */
function findSubpos(content: string): SubPos {
  const nul = content.indexOf("\0");
  const buf = nul >= 0 ? content.slice(0, nul) : content;
  let at = 0;
  // skip past the header until an empty line
  while (at < buf.length && buf[at] !== "\n") {
    const eol = buf.indexOf("\n", at);
    at = eol >= 0 ? eol + 1 : buf.length;
  }
  while (buf[at] === "\n") at++;
  const sigstart = at + signatureStart(buf.slice(at));
  const sub = at;
  let eol = buf.indexOf("\n\n", sub);
  if (eol < 0) eol = buf.indexOf("\r\n\r\n", sub);
  eol = eol >= 0 ? Math.min(eol, sigstart) : sigstart;
  at = eol;
  let sublen = at - sub;
  while (sublen && (buf[sub + sublen - 1] === "\n" || buf[sub + sublen - 1] === "\r")) sublen--;
  while (buf[at] === "\n" || buf[at] === "\r") at++;
  return { sub, sublen, body: at, nonsiglen: sigstart - at, sig: sigstart, buf };
}

/** copy_subject: newlines as spaces, the CR of a CRLF dropped. */
function copySubject(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (c === "\r" && text[i + 1] === "\n") continue;
    out += c === "\n" ? " " : c;
  }
  return out;
}

/** append_lines: `lines` lines, joined with a newline and four spaces. */
function appendLines(text: string, lines: number): string {
  let out = "";
  let sp = 0;
  for (let i = 0; i < lines && sp < text.length; i++) {
    if (i) out += "\n    ";
    const eol = text.indexOf("\n", sp);
    out += eol >= 0 ? text.slice(sp, eol) : text.slice(sp);
    if (eol < 0) break;
    sp = eol + 1;
  }
  return out;
}

/** find_wholine: the rest of the header line `who ...`, "" when there is none. */
function findWholine(who: string, buf: string): string {
  let at = 0;
  while (at < buf.length) {
    if (buf.startsWith(`${who} `, at)) {
      const start = at + who.length + 1;
      const eol = buf.indexOf("\n", start);
      return eol >= 0 ? buf.slice(start, eol) : buf.slice(start);
    }
    const eol = buf.indexOf("\n", at);
    if (eol < 0) return "";
    if (buf[eol + 1] === "\n") return "";
    at = eol + 1;
  }
  return "";
}

/** copy_name: the identity's name (up to ` <`), "" without one. */
function copyName(line: string): string {
  const at = line.indexOf(" <");
  return at >= 0 ? line.slice(0, at) : "";
}

/** copy_email with the atom's options. */
function copyEmail(line: string, opt: NonNullable<UsedAtom["email"]>): string {
  let start = line.indexOf("<");
  if (start < 0) return "";
  if (opt.localpart || opt.trim) start++;
  const rest = line.slice(start);
  let end: number;
  if (opt.localpart) {
    end = rest.indexOf("@");
    if (end < 0) end = rest.indexOf(">");
  } else if (opt.trim) end = rest.indexOf(">");
  else {
    end = rest.indexOf(">");
    if (end >= 0) end++;
  }
  return end < 0 ? "" : rest.slice(0, end);
}

/** apply_mailmap_to_header for one identity line's value (`name <email> rest`). */
function mailmapLine(line: string, mailmap: Mailmap): string {
  const lt = line.indexOf("<");
  const gt = line.indexOf(">", lt + 1);
  if (lt < 0 || gt < 0) return line;
  const name = line.slice(0, lt).replace(/ +$/, "");
  const email = line.slice(lt + 1, gt);
  const mapped = mailmap.map(name, email);
  if (mapped.name === name && mapped.email === email) return line;
  return `${mapped.name} <${mapped.email}>${line.slice(gt + 1)}`;
}

/** The commit's tree and parents from its header. */
function commitLinks(buf: string): { tree?: string; parents: string[] } {
  const out: { tree?: string; parents: string[] } = { parents: [] };
  for (const line of buf.slice(0, Math.max(buf.indexOf("\n\n"), 0) || buf.length).split("\n")) {
    if (line.startsWith("tree ") && out.tree === undefined) out.tree = line.slice(5);
    else if (line.startsWith("parent ")) out.parents.push(line.slice(7));
  }
  return out;
}

/** A tag's `object`, `type` and `tag` header values. */
export function tagHeader(buf: string): { object?: string; type?: string; tag?: string } {
  const out: { object?: string; type?: string; tag?: string } = {};
  const end = buf.indexOf("\n\n");
  for (const line of (end >= 0 ? buf.slice(0, end) : buf).split("\n")) {
    if (line.startsWith("object ") && out.object === undefined) out.object = line.slice(7);
    else if (line.startsWith("type ") && out.type === undefined) out.type = line.slice(5);
    else if (line.startsWith("tag ") && out.tag === undefined) out.tag = line.slice(4);
  }
  return out;
}

/** One level of the format's output stack (ref-filter.c's ref_formatting_stack). */
interface Stack {
  prev?: Stack;
  output: string;
  atEnd?: "align" | "if";
  align?: NonNullable<UsedAtom["align"]>;
  ifState?: IfState;
}

interface IfState {
  cmp: "equal" | "unequal" | "none";
  str?: string;
  thenSeen: boolean;
  elseSeen: boolean;
  satisfied: boolean;
}

/** A piece of a parsed format: literal text or an atom. */
type Piece = { literal: string } | { atom: number; text: string };

/** append_literal: `%%` and `%<hex><hex>` expanded. */
function expandLiteral(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (c === "%") {
      if (text[i + 1] === "%") {
        out += "%";
        i++;
        continue;
      }
      const hex = /^[0-9a-fA-F]{2}/.exec(text.slice(i + 1, i + 3));
      if (hex) {
        const n = Number.parseInt(hex[0], 16);
        // a byte above 0x7f is kept as the byte it is
        out += n < 0x80 ? String.fromCharCode(n) : decodeGitPath(Uint8Array.of(n));
        i += 2;
        continue;
      }
    }
    out += c;
  }
  return out;
}

/** utf8 width of a text, git's `utf8_strnwidth` (bytes that are no UTF-8 count one each). */
const textWidth = (text: string) => gitStrWidth(encodeGitPath(text));

/**
 * A format and the sort keys of one listing, with the atoms they use (git keeps one list
 * for both), and each ref's values.
 */
export class RefFormat {
  /** The atoms parsed, in order (git's `used_atom`) */
  readonly atoms: UsedAtom[] = [];
  private readonly pieces: Piece[] = [];
  private needColorReset = false;
  private needTagged = false;
  private readonly quoteStyle: RefQuoteStyle;
  private readonly useColor: boolean;
  private readonly peelNested: boolean;
  private headTarget?: Promise<string | undefined>;
  private mailmapLoad?: Promise<Mailmap>;
  private dateModes = new Map<string, DateMode>();

  /**
   * `format` verified as git's verify_ref_format does (atoms parsed, `%(rest)` refused,
   * `%(raw)` refused with `--shell`/`--python`/`--tcl`).
   *
   * @throws RefFilterError with git's message
   */
  constructor(
    format: string,
    private readonly source: RefFormatSource,
    options: RefFormatOptions = {},
  ) {
    this.quoteStyle = options.quoteStyle ?? "none";
    this.useColor = options.useColor ?? false;
    this.peelNested = options.compatibility !== "2.43";
    let cp = 0;
    for (;;) {
      const sp = findNext(format, cp);
      if (sp < 0) break;
      const ep = format.indexOf(")", sp);
      if (ep < 0) {
        throw new RefFilterError(`error: malformed format string ${format.slice(sp)}`, 129);
      }
      const text = format.slice(sp + 2, ep);
      const at = this.atomIndex(text);
      const atom = this.atoms[at] as UsedAtom;
      if (atom.type === "rest") throw fatal(`this command reject atom %(${text})`);
      if (
        (this.quoteStyle === "python" ||
          this.quoteStyle === "shell" ||
          this.quoteStyle === "tcl") &&
        atom.type === "raw" &&
        atom.raw === "bare"
      ) {
        throw fatal(`--format=${text} cannot be used with --python, --shell, --tcl`);
      }
      if (sp > cp) this.pieces.push({ literal: expandLiteral(format.slice(cp, sp)) });
      this.pieces.push({ atom: at, text });
      if (text.startsWith("color:")) this.needColorReset = text !== "color:reset";
      cp = ep + 1;
    }
    if (cp < format.length) this.pieces.push({ literal: expandLiteral(format.slice(cp)) });
    if (!this.useColor) this.needColorReset = false;
  }

  /**
   * The index of an atom (parse_ref_filter_atom): one used before with the same text, else
   * a new one; sort keys are parsed through this too.
   */
  atomIndex(text: string): number {
    const known = this.atoms.findIndex((a) => a.name === text);
    if (known >= 0) return known;
    const atom = parseAtom(text, { useColor: this.useColor });
    if (atom.deref) this.needTagged = true;
    this.atoms.push(atom);
    return this.atoms.length - 1;
  }

  /** The sort type an atom compares by (a date atom with a format compares as text). */
  cmpTypeOf(index: number): AtomCmpType {
    return (this.atoms[index] as UsedAtom).cmpType;
  }

  /** Whether an atom of this kind is used (`ahead-behind`, `is-base`, ...). */
  uses(type: UsedAtom["type"]): boolean {
    return this.atoms.some((a) => a.type === type);
  }

  /** The value of atom `index` for `item`, its values computed first if needed. */
  async value(item: RefFilterItem, index: number): Promise<AtomValue> {
    if (!item.values || item.values.length < this.atoms.length) await this.populate(item);
    return (item.values as AtomValue[])[index] as AtomValue;
  }

  /**
   * format_ref_array_item: the format expanded for `item`.
   *
   * @throws RefFilterError where git dies
   */
  async format(item: RefFilterItem): Promise<string> {
    let stack: Stack = { output: "" };
    const quote = this.quoteStyle;
    const append = (v: { s: string; sized?: boolean }) => {
      if (!stack.prev) stack.output += quoteRefValue(v.s, quote, v.sized);
      else stack.output += quoteRefValue(v.s, "none", v.sized);
    };
    for (const piece of this.pieces) {
      if ("literal" in piece) {
        stack.output += piece.literal;
        continue;
      }
      const v = await this.value(item, piece.atom);
      const atom = v.atom;
      switch (atom.type) {
        case "align":
          stack = {
            prev: stack,
            output: "",
            atEnd: "align",
            ...(atom.align ? { align: atom.align } : {}),
          };
          break;
        case "if":
          stack = {
            prev: stack,
            output: "",
            atEnd: "if",
            ifState: {
              cmp: atom.ifThenElse?.cmp ?? "none",
              ...(atom.ifThenElse?.str !== undefined ? { str: atom.ifThenElse.str } : {}),
              thenSeen: false,
              elseSeen: false,
              satisfied: false,
            },
          };
          break;
        case "then": {
          const state = stack.atEnd === "if" ? stack.ifState : undefined;
          if (!state) throw fatal("format: %(then) atom used without a %(if) atom");
          if (state.thenSeen) throw fatal("format: %(then) atom used more than once");
          if (state.elseSeen) throw fatal("format: %(then) atom used after %(else)");
          state.thenSeen = true;
          const out = stack.output;
          if (state.cmp === "equal") state.satisfied = out === (state.str ?? "");
          else if (state.cmp === "unequal") state.satisfied = out !== (state.str ?? "");
          else state.satisfied = out.length > 0 && ![...out].every(isSpace);
          stack.output = "";
          break;
        }
        case "else": {
          const state = stack.atEnd === "if" ? stack.ifState : undefined;
          if (!state) throw fatal("format: %(else) atom used without a %(if) atom");
          if (!state.thenSeen) throw fatal("format: %(else) atom used without a %(then) atom");
          if (state.elseSeen) throw fatal("format: %(else) atom used more than once");
          state.elseSeen = true;
          stack = { prev: stack, output: "", atEnd: "if", ifState: state };
          break;
        }
        case "end": {
          if (!stack.atEnd) throw fatal("format: %(end) atom used without corresponding atom");
          stack = endHandler(stack);
          const current = stack;
          const prev = current.prev as Stack;
          if (!prev.prev) current.output = quoteRefValue(current.output, quote);
          prev.output += current.output;
          stack = prev;
          break;
        }
        default:
          append(v);
      }
    }
    if (this.needColorReset) append({ s: "\x1b[m" });
    if (stack.prev) throw fatal("format: %(end) atom missing");
    return stack.output;
  }

  /** populate_value: every atom's value for `item`. */
  private async populate(item: RefFilterItem): Promise<void> {
    const values: AtomValue[] = this.atoms.map((atom) => ({
      s: undefined as unknown as string,
      value: 0,
      atom,
    }));
    const source = this.source;
    let aheadBehindIndex = 0;
    let isBaseIndex = 0;
    for (const v of values) {
      const atom = v.atom;
      let refname: string | undefined;
      switch (atom.type) {
        case "refname":
          refname =
            item.kind & RefKind.DETACHED_HEAD
              ? ((await source.headDescription?.()) ?? "(no branch)")
              : await this.showRef(atom.refname, item.refname);
          break;
        case "worktreepath":
          v.s =
            item.kind === RefKind.BRANCHES ? ((await source.worktreePath(item.refname)) ?? "") : "";
          continue;
        case "symref":
          refname = item.symref === undefined ? "" : await this.showRef(atom.refname, item.symref);
          break;
        case "upstream": {
          if (!item.refname.startsWith("refs/heads/")) {
            v.s = "";
            continue;
          }
          const branch = item.refname.slice(11);
          const upstream = await source.upstreamOf(branch);
          v.s = upstream ? await this.remoteDetails(atom, upstream, item.refname, branch) : "";
          continue;
        }
        case "push": {
          v.s = "";
          if (!item.refname.startsWith("refs/heads/")) continue;
          const branch = item.refname.slice(11);
          let ref: string | undefined;
          if (!atom.remote?.pushRemote) {
            ref = await source.pushOf(branch);
            if (!ref) continue;
          }
          v.s = await this.remoteDetails(atom, ref, item.refname, branch);
          continue;
        }
        case "color":
          v.s = atom.color ?? "";
          continue;
        case "flag": {
          const flags: string[] = [];
          if (item.flags.symref) flags.push("symref");
          if (item.flags.packed) flags.push("packed");
          v.s = flags.join(",");
          continue;
        }
        case "objectname":
          if (atom.deref) continue;
          v.s = await this.oidText(item.objectId, atom);
          continue;
        case "HEAD": {
          this.headTarget ??= source.headRef();
          const head = await this.headTarget;
          v.s = head !== undefined && head === item.refname ? "*" : " ";
          continue;
        }
        case "align":
        case "end":
        case "if":
        case "then":
        case "else":
          v.s = "";
          continue;
        case "rest":
          v.s = item.rest ?? "";
          continue;
        case "ahead-behind": {
          const count = item.counts?.[aheadBehindIndex++];
          v.s = count ? `${count.ahead} ${count.behind}` : "";
          continue;
        }
        case "is-base": {
          const name = item.isBase?.[isBaseIndex++];
          v.s = name !== undefined ? `(${name})` : "";
          continue;
        }
        default:
          continue;
      }
      v.s = atom.deref ? `${refname}^{}` : (refname as string);
    }
    const needsObject = this.atoms.some(
      (a) =>
        a.deref ||
        a.source === "obj" ||
        a.type === "objecttype" ||
        a.type === "objectsize" ||
        a.type === "deltabase",
    );
    if (needsObject) {
      const object = await source.readObject(item.objectId);
      if (!object) throw fatal(`missing object ${item.objectId} for ${item.refname}`);
      await this.grabValues(values, false, item.objectId, object, item.refname);
      if (this.needTagged && object.type === "tag") {
        const peeled = this.peelNested
          ? (item.peeledId ?? (await this.peel(item.objectId, object)))
          : tagHeader(decodeGitPath(object.bytes)).object;
        if (peeled === undefined) throw fatal("bad tag");
        const target = await source.readObject(peeled);
        if (!target) throw fatal(`missing object ${peeled} for ${item.refname}`);
        await this.grabValues(values, true, peeled, target, item.refname);
      }
    }
    for (const v of values) if (v.s === undefined) v.s = "";
    item.values = values;
  }

  /** peel_object with PEEL_OBJECT_VERIFY_TAGGED_OBJECT_TYPE: undefined for a bad tag. */
  private async peel(id: ObjectId, object: RefFormatObject): Promise<ObjectId | undefined> {
    let current = object;
    let currentId = id;
    for (let depth = 0; current.type === "tag" && depth < 1000; depth++) {
      const header = tagHeader(decodeGitPath(current.bytes));
      if (!header.object || !header.type) return undefined;
      const next = await this.source.readObject(header.object);
      if (!next) return undefined;
      if (next.type !== header.type) {
        // object_as_type: the object was looked up as the type the tag declares
        throw new RefFilterError(
          `error: object ${header.object} is a ${header.type}, not a ${next.type}\nfatal: bad tag`,
          128,
        );
      }
      current = next;
      currentId = header.object;
    }
    return currentId;
  }

  private async showRef(option: UsedAtom["refname"], name: string): Promise<string> {
    switch (option?.option) {
      case "short": {
        const warn = this.source.config("core.warnAmbiguousRefs");
        const strict = warn === undefined ? true : parseBool(warn);
        return shortenRefName(name, strict, (n) => this.source.refExists(n));
      }
      case "lstrip":
        return lstripRef(name, option.lstrip ?? 0);
      case "rstrip":
        return rstripRef(name, option.rstrip ?? 0);
      default:
        return name;
    }
  }

  /** fill_remote_ref_details. */
  private async remoteDetails(
    atom: UsedAtom,
    ref: string | undefined,
    branchRef: string,
    branch: string,
  ): Promise<string> {
    const remote = atom.remote as NonNullable<UsedAtom["remote"]>;
    const source = this.source;
    const stat = async (): Promise<{ ahead: number; behind: number } | undefined> => {
      const base = remote.push ? await source.pushOf(branch) : await source.upstreamOf(branch);
      if (!base) return undefined;
      const theirs = await source.refCommit(base);
      const ours = theirs ? await source.refCommit(branchRef) : undefined;
      if (!theirs || !ours) return undefined;
      if (theirs === ours) return { ahead: 0, behind: 0 };
      return source.aheadBehind(ours, theirs);
    };
    switch (remote.option) {
      case "ref":
        return this.showRef(atom.refname, ref ?? "");
      case "track": {
        const counts = await stat();
        let s: string;
        if (!counts) s = "gone";
        else if (!counts.ahead && !counts.behind) s = "";
        else if (!counts.ahead) s = `behind ${counts.behind}`;
        else if (!counts.behind) s = `ahead ${counts.ahead}`;
        else s = `ahead ${counts.ahead}, behind ${counts.behind}`;
        return !remote.nobracket && s ? `[${s}]` : s;
      }
      case "trackshort": {
        const counts = await stat();
        if (!counts) return "";
        if (!counts.ahead && !counts.behind) return "=";
        if (!counts.ahead) return "<";
        if (!counts.behind) return ">";
        return "<>";
      }
      case "remotename":
        return source.remoteName(branch, remote.push);
      case "remoteref":
        return source.remoteRef(branch, remote.push) ?? "";
    }
  }

  private async oidText(id: ObjectId, atom: UsedAtom): Promise<string> {
    switch (atom.oid?.option) {
      case "short":
        return this.source.abbreviate(id);
      case "length":
        return this.source.abbreviate(id, atom.oid.length);
      default:
        return id;
    }
  }

  /** grab_values (and grab_common_values) of one object, the ref's own or the peeled one. */
  private async grabValues(
    values: AtomValue[],
    deref: boolean,
    id: ObjectId,
    object: RefFormatObject,
    refname: string,
  ): Promise<void> {
    const mine = values.filter((v) => v.atom.deref === deref);
    if (mine.length === 0) return;
    const buf = decodeGitPath(object.bytes);
    // common values
    for (const v of mine) {
      const atom = v.atom;
      if (atom.type === "objecttype") v.s = object.type;
      else if (atom.type === "objectsize") {
        if (atom.objectsize === "disk") {
          throw fatal(`%(${atom.name}) is not supported: object disk sizes are not available`);
        }
        v.value = object.bytes.length;
        v.s = String(object.bytes.length);
      } else if (atom.type === "deltabase") {
        throw fatal(`%(${atom.name}) is not supported: delta bases are not available`);
      } else if (atom.type === "objectname" && deref) v.s = await this.oidText(id, atom);
    }
    if (object.type === "tag") {
      const header = tagHeader(buf);
      if (!header.object || !header.type || header.tag === undefined) {
        throw fatal(`parse_object_buffer failed on ${id} for ${refname}`);
      }
      for (const v of mine) {
        if (v.atom.type === "tag") v.s = header.tag;
        else if (v.atom.type === "type") v.s = header.type;
        else if (v.atom.type === "object") v.s = header.object;
      }
      await this.grabContents(mine, object, buf);
      await this.grabPerson("tagger", mine, buf);
      await this.grabDescribe(mine, id, object);
    } else if (object.type === "commit") {
      const links = commitLinks(buf);
      for (const v of mine) {
        const atom = v.atom;
        if (atom.type === "tree" && links.tree) v.s = await this.oidText(links.tree, atom);
        else if (atom.type === "numparent") {
          v.value = links.parents.length;
          v.s = String(links.parents.length);
        } else if (atom.type === "parent") {
          const parts: string[] = [];
          for (const p of links.parents) parts.push(await this.oidText(p, atom));
          v.s = parts.join(" ");
        }
      }
      await this.grabContents(mine, object, buf);
      await this.grabPerson("author", mine, buf);
      await this.grabPerson("committer", mine, buf);
      this.grabSignature(mine, buf);
      await this.grabDescribe(mine, id, object);
    } else {
      await this.grabContents(mine, object, buf);
    }
  }

  /** grab_sub_body_contents. */
  private async grabContents(values: AtomValue[], object: RefFormatObject, buf: string) {
    let pos: SubPos | undefined;
    for (const v of values) {
      const atom = v.atom;
      if (atom.type === "raw") {
        if (atom.raw === "bare") {
          v.s = buf;
          v.sized = true;
        } else {
          v.value = object.bytes.length;
          v.s = String(object.bytes.length);
        }
        continue;
      }
      if (object.type !== "tag" && object.type !== "commit") continue;
      if (!["body", "subject", "trailers", "contents"].includes(atom.type)) continue;
      pos ??= findSubpos(buf);
      const { sub, sublen, body, nonsiglen, sig } = pos;
      const text = pos.buf;
      switch (atom.contents?.option) {
        case "sub":
          v.s = copySubject(text.slice(sub, sub + sublen));
          break;
        case "sub-sanitize":
          v.s = sanitizedSubject(text.slice(sub, sub + sublen));
          break;
        case "body-dep":
          v.s = text.slice(body);
          break;
        case "length":
          v.value = encodeGitPath(text.slice(sub)).length;
          v.s = String(v.value);
          break;
        case "body":
          v.s = text.slice(body, body + nonsiglen);
          break;
        case "sig":
          v.s = text.slice(sig);
          break;
        case "lines":
          v.s = appendLines(text.slice(sub, body + nonsiglen), atom.contents.lines ?? 0);
          break;
        case "trailers": {
          const msg = sig < text.length && this.peelNested ? text.slice(sub, sig) : text.slice(sub);
          v.s = appendTrailers("", msg, atom.contents.trailers ?? {}, this.source.trailerConfig());
          break;
        }
        case "bare":
          v.s = text.slice(sub);
          break;
      }
    }
  }

  /** grab_person: `who`'s name, email, date, line, and the creator atoms. */
  private async grabPerson(
    who: "author" | "committer" | "tagger",
    values: AtomValue[],
    buf: string,
  ) {
    let wholine: string | undefined;
    for (const v of values) {
      const atom = v.atom;
      const base = atom.type.startsWith(who) ? atom.type.slice(who.length) : undefined;
      if (base === undefined || !["", "name", "email", "date"].includes(base)) continue;
      const mapped =
        (base === "name" && atom.nameMailmap) || (base === "email" && atom.email?.mailmap);
      if (mapped) {
        this.mailmapLoad ??= this.source.mailmap();
        const mailmap = await this.mailmapLoad;
        const line = findWholine(who, buf);
        wholine = line === "" ? "" : mailmapLine(line, mailmap);
      } else wholine = findWholine(who, buf);
      if (base === "") v.s = wholine;
      else if (base === "name") v.s = copyName(wholine);
      else if (base === "email")
        v.s = copyEmail(wholine, atom.email as NonNullable<UsedAtom["email"]>);
      else this.grabDate(wholine, v);
    }
    if (who !== "tagger" && who !== "committer") return;
    wholine ??= findWholine(who, buf);
    for (const v of values) {
      if (v.atom.type === "creatordate") this.grabDate(wholine, v);
      else if (v.atom.type === "creator") v.s = wholine;
    }
  }

  /** grab_date: the date of an identity line as the atom's format shows it. */
  private grabDate(line: string, v: AtomValue): void {
    const name = v.atom.deref ? v.atom.name.slice(1) : v.atom.name;
    const colon = name.indexOf(":");
    let mode: DateMode = { type: "normal", local: false };
    if (colon >= 0) {
      const spec = name.slice(colon + 1);
      let parsed = this.dateModes.get(spec);
      if (!parsed) {
        try {
          parsed = parseDateMode(spec);
        } catch (e) {
          throw new RefFilterError((e as Error).message, 128);
        }
        this.dateModes.set(spec, parsed);
      }
      mode = parsed;
      // a formatted date sorts as text (git 2.43: by its time still)
      if (this.peelNested) v.atom.cmpType = "str";
    }
    const eoemail = line.indexOf("> ");
    const m = eoemail >= 0 ? /^[ \t\n\v\f\r]*\+?(\d+)(.*)$/s.exec(line.slice(eoemail + 2)) : null;
    if (!m) {
      v.s = "";
      v.value = 0;
      return;
    }
    const timestamp = Number(m[1]);
    const zone = /^[ \t\n\v\f\r]*([+-]?\d+)/.exec(m[2] as string)?.[1] ?? "+0000";
    const tz = Number.parseInt(zone, 10);
    const tzText = `${tz < 0 ? "-" : "+"}${String(Math.abs(tz)).padStart(4, "0")}`;
    v.s = showDate(timestamp, tzText, mode, this.source.dateContext);
    v.value = timestamp;
  }

  /** grab_signature for an unsigned commit; a signed one cannot be verified here. */
  private grabSignature(values: AtomValue[], buf: string): void {
    const atoms = values.filter((v) => v.atom.type === "signature");
    if (atoms.length === 0) return;
    const header = buf.slice(0, Math.max(buf.indexOf("\n\n"), 0));
    if (/(^|\n)gpgsig(-sha256)? /.test(header)) {
      throw fatal("%(signature) is not supported: signatures cannot be verified");
    }
    for (const v of atoms) {
      const option = v.atom.signature;
      v.s = option === "grade" ? "N" : option === "trustlevel" ? "undefined" : "";
    }
  }

  private async grabDescribe(values: AtomValue[], id: ObjectId, object: RefFormatObject) {
    for (const v of values) {
      if (v.atom.type !== "describe") continue;
      let target = id;
      if (object.type === "tag") target = (await this.peel(id, object)) ?? id;
      const out = await this.source.describe(
        target,
        v.atom.describe as NonNullable<UsedAtom["describe"]>,
      );
      v.s = out.replace(/[ \t\n\v\f\r]+$/, "");
    }
  }
}

function parseBool(value: string): boolean {
  const v = value.toLowerCase();
  if (v === "true" || v === "yes" || v === "on") return true;
  if (v === "false" || v === "no" || v === "off" || v === "") return false;
  return Number(v) !== 0;
}

/** find_next: the next `%(` not escaped as `%%`. */
function findNext(format: string, from: number): number {
  for (let i = from; i < format.length; i++) {
    if (format[i] === "%") {
      if (format[i + 1] === "(") return i;
      if (format[i + 1] === "%") i++;
    }
  }
  return -1;
}

/** The handlers of `%(end)`: align's padding, if/then/else's choice. */
function endHandler(cur: Stack): Stack {
  if (cur.atEnd === "align") {
    const align = cur.align as NonNullable<UsedAtom["align"]>;
    const nul = cur.output.indexOf("\0");
    const s = nul >= 0 ? cur.output.slice(0, nul) : cur.output;
    const width = textWidth(s);
    if (width >= align.width) cur.output = s;
    else if (align.position === "left") cur.output = s + " ".repeat(align.width - width);
    else if (align.position === "right") cur.output = " ".repeat(align.width - width) + s;
    else {
      const left = Math.floor((align.width - width) / 2);
      cur.output = " ".repeat(left) + s + " ".repeat(align.width - width - left);
    }
    return cur;
  }
  const state = cur.ifState as IfState;
  if (!state.thenSeen) throw fatal("format: %(if) atom used without a %(then) atom");
  if (state.elseSeen) {
    const prev = cur.prev as Stack;
    if (state.satisfied) {
      prev.output += "";
      return prev;
    }
    // the else branch's text replaces the then branch's
    prev.output = cur.output;
    return prev;
  }
  if (!state.satisfied) cur.output = "";
  return cur;
}
