/**
 * Objects translated between a repository's two object formats (`extensions.objectFormat`
 * and `extensions.compatObjectFormat`), as git's object-file-convert.c: a tree's entry ids,
 * a commit's `tree`/`parent` lines and `mergetag`s, and a tag's `object` line are rewritten
 * through the loose object map; a blob is the same bytes in both formats. What git cannot
 * map (an id the map lacks, a commit header it does not know) fails the conversion with
 * git's lines, `fatal: Failed to convert object from <from> to <to>` last, before anything is
 * written.
 */

import type { ObjectTypeString } from "@statewalker/vcs-core";
import { bytesToHex, hexToBytes, type ObjectFormat } from "@statewalker/vcs-utils/hash";

/** Maps an id of one format to the other one (undefined when the map has none). */
export type CompatIdMapper = (id: string) => Promise<string | undefined>;

/**
 * A conversion git refuses: `lines` are what git prints (its `error:` lines, then the
 * `fatal:` it dies with), the message their last line.
 */
export class CompatObjectConversionError extends Error {
  readonly lines: readonly string[];
  constructor(lines: string[]) {
    super(lines.map((l) => l.replace(/^(error|fatal): /, "")).join("\n"));
    this.name = "CompatObjectConversionError";
    this.lines = lines;
  }
}

/** One byte per character (bytes above 0x7f too: messages need not be UTF-8). */
export function latin1(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000) as unknown as number[]);
  }
  return out;
}

/** The bytes of a `latin1` string. */
export function latin1Bytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
  return out;
}

/** git's `error()` lines, the conversion's failure; `undefined` for a silent `return -1`. */
class Refused {
  constructor(readonly line?: string) {}
}

const HEX = /^[0-9a-f]+$/;

/** gpg_sig_headers: the header carrying a signature over the object in `format` */
function sigHeader(format: ObjectFormat): string {
  return format.signatureHeader;
}

/**
 * gpg-interface.c `parse_signed_buffer`: where the last line starting a signature begins
 * (the whole length when none does).
 */
export function parseSignedBuffer(text: string): number {
  let len = 0;
  let match = text.length;
  while (len < text.length) {
    if (startsSignature(text, len)) match = len;
    const eol = text.indexOf("\n", len);
    len = eol < 0 ? text.length : eol + 1;
  }
  return match;
}

/** gpg-interface.c `get_format_by_sig`: the signature formats' start markers */
const SIGNATURE_STARTS = [
  "-----BEGIN PGP SIGNATURE-----",
  "-----BEGIN PGP MESSAGE-----",
  "-----BEGIN SIGNED MESSAGE-----",
  "-----BEGIN SSH SIGNATURE-----",
];

function startsSignature(text: string, at: number): boolean {
  for (const s of SIGNATURE_STARTS) if (text.startsWith(s, at)) return true;
  return false;
}

/**
 * commit.c `parse_buffer_signed_by_header`: the buffer without the `header` signature (and
 * without other formats' signature headers), and that signature with its continuation spaces
 * removed.
 */
export function parseBufferSignedByHeader(
  text: string,
  header: string,
): { payload: string; signature: string } {
  let inSignature = false;
  let otherSignature = false;
  let payload = "";
  let signature = "";
  let line = 0;
  const tail = text.length;
  while (line < tail) {
    let sig: number | undefined;
    const nl = text.indexOf("\n", line);
    let next = nl < 0 ? tail : nl + 1;
    if (inSignature && text[line] === " ") sig = line + 1;
    else if (text.startsWith(header, line) && text[line + header.length] === " ") {
      sig = line + header.length + 1;
      otherSignature = false;
    } else if (text.startsWith("gpgsig", line)) otherSignature = true;
    else if (otherSignature && text[line] !== " ") otherSignature = false;
    if (sig !== undefined) {
      signature += text.slice(sig, next);
      inSignature = true;
    } else {
      // the message: the whole remainder of the buffer
      if (text[line] === "\n") next = tail;
      if (!otherSignature) payload += text.slice(line, next);
      inSignature = false;
    }
    line = next;
  }
  return { payload, signature };
}

/**
 * gpg-interface.c `add_header_signature`: `sig`'s lines as the `header` of `format`, inserted
 * at the end of the header (before the first empty line, else at the end).
 */
export function addHeaderSignature(buf: string, sig: string, format: ObjectFormat): string {
  const eoh = buf.indexOf("\n\n");
  const at = eoh < 0 ? buf.length : eoh + 1;
  let block = "";
  let copy = 0;
  while (copy < sig.length && sig.charCodeAt(copy) !== 0) {
    const nl = sig.indexOf("\n", copy);
    const end = nl < 0 ? sig.length : nl + 1;
    if (copy === 0) block += sigHeader(format);
    block += ` ${sig.slice(copy, end)}`;
    copy = end;
  }
  return buf.slice(0, at) + block + buf.slice(at);
}

async function mapId(map: CompatIdMapper, id: string): Promise<string | undefined> {
  return map(id);
}

/** convert_tree_object */
async function convertTree(
  content: Uint8Array,
  from: ObjectFormat,
  to: ObjectFormat,
  map: CompatIdMapper,
): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  let total = 0;
  let p = 0;
  const end = content.length;
  while (p < end) {
    const size = end - p;
    // decode_tree_entry_raw
    if (size < from.rawLength + 3 || content[end - (from.rawLength + 1)] !== 0) {
      throw new Refused("failed to decode tree entry");
    }
    const sp = content.indexOf(0x20, p);
    const mode = sp < 0 ? "" : latin1(content.subarray(p, sp));
    if (sp < 0 || !/^[0-7]+$/.test(mode)) throw new Refused("failed to decode tree entry");
    const nameStart = sp + 1;
    const nul = content.indexOf(0, nameStart);
    if (nul < 0 || nul === nameStart) throw new Refused("failed to decode tree entry");
    const idAt = nul + 1;
    const id = bytesToHex(content.subarray(idAt, idAt + from.rawLength));
    const mapped = await mapId(map, id);
    if (!mapped) throw new Refused(`failed to map tree entry for ${id}`);
    const head = content.subarray(p, idAt);
    parts.push(head, hexToBytes(mapped));
    total += head.length + to.rawLength;
    p = idAt + from.rawLength;
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

function parseHexId(text: string, at: number, format: ObjectFormat): string | undefined {
  const id = text.slice(at, at + format.hexLength);
  return id.length === format.hexLength && HEX.test(id) ? id : undefined;
}

/** convert_tag_object */
async function convertTag(
  text: string,
  from: ObjectFormat,
  to: ObjectFormat,
  map: CompatIdMapper,
): Promise<string> {
  const entryLen = from.hexLength + 7;
  if (entryLen >= text.length || !text.startsWith("object ") || text[entryLen] !== "\n") {
    throw new Refused("bogus tag object");
  }
  const id = parseHexId(text, 7, from);
  if (!id) throw new Refused("bad tag object ID");
  const mapped = await mapId(map, id);
  if (!mapped) throw new Refused(`unable to map tree ${id} in tag object`);
  const rest = text.slice(entryLen + 1);
  // a signature over this format's object at the end of the message
  const payloadSize = parseSignedBuffer(rest);
  const ourSig = payloadSize !== rest.length ? rest.slice(payloadSize) : "";
  // the other format's signature, in a header
  const { payload, signature: otherSig } = parseBufferSignedByHeader(
    rest.slice(0, payloadSize),
    sigHeader(to),
  );
  let out = `object ${mapped}\n${payload}`;
  if (ourSig) out = addHeaderSignature(out, ourSig, from);
  return out + otherSig;
}

/** convert_commit_object */
async function convertCommit(
  text: string,
  from: ObjectFormat,
  to: ObjectFormat,
  map: CompatIdMapper,
): Promise<string> {
  const tail = text.length;
  let p = 0;
  let out = "";
  const treeLen = from.hexLength + 5;
  const parentLen = from.hexLength + 7;
  while (p < tail && text[p] !== "\n") {
    let eol = text.indexOf("\n", p);
    if (eol < 0) throw new Refused("bad line in commit");
    if (p + 5 < eol && text.startsWith("tree ", p)) {
      const id = p + treeLen === eol ? parseHexId(text, p + 5, from) : undefined;
      if (!id) throw new Refused("bad tree in commit");
      const mapped = await mapId(map, id);
      if (!mapped) throw new Refused(`unable to map tree ${id} in commit object`);
      out += `tree ${mapped}\n`;
    } else if (p + 7 < eol && text.startsWith("parent ", p)) {
      const id = p + parentLen === eol ? parseHexId(text, p + 7, from) : undefined;
      if (!id) throw new Refused("bad parent in commit");
      const mapped = await mapId(map, id);
      if (!mapped) throw new Refused(`unable to map parent ${id} in commit object`);
      out += `parent ${mapped}\n`;
    } else if (p + 9 < eol && text.startsWith("mergetag ", p)) {
      // the tag object, recovered from the header and its continuation lines
      let tag = text.slice(p + 9, eol + 1);
      p = eol + 1;
      while (p < tail && text[p] === " ") {
        eol = text.indexOf("\n", p);
        if (eol < 0) throw new Refused("bad mergetag continuation in commit");
        tag += text.slice(p + 1, eol + 1);
        p = eol + 1;
      }
      const converted = await convertTag(tag, from, to, map);
      // strbuf_add_lines(out, " ", ...) after "mergetag"
      out += "mergetag";
      out += addLines(" ", converted);
      continue;
    } else if (p + 7 < tail && text.startsWith("author ", p)) out += text.slice(p, eol + 1);
    else if (p + 10 < tail && text.startsWith("committer ", p)) out += text.slice(p, eol + 1);
    else if (p + 9 < tail && text.startsWith("encoding ", p)) out += text.slice(p, eol + 1);
    else if (p + 6 < tail && text.startsWith("gpgsig", p)) out += text.slice(p, eol + 1);
    // an unknown header might embed an id: refused without a message
    else throw new Refused();
    // the continuation lines
    p = eol + 1;
    while (p < tail && text[p] === " ") {
      eol = text.indexOf("\n", p);
      if (eol < 0) throw new Refused("bad continuation in commit");
      out += text.slice(p, eol + 1);
      p = eol + 1;
    }
  }
  if (p < tail) out += text.slice(p);
  return out;
}

/** strbuf_add_lines: `prefix` before every line, a newline after the last one */
function addLines(prefix: string, text: string): string {
  let out = "";
  let at = 0;
  while (at < text.length) {
    const nl = text.indexOf("\n", at);
    const end = nl < 0 ? text.length : nl + 1;
    out += prefix + text.slice(at, end);
    at = end;
  }
  if (out.length > 0 && !out.endsWith("\n")) out += "\n";
  return out;
}

/**
 * git's `convert_object_file`: `content` (an object of `type` in `from`) as the object of
 * `to`, its ids mapped through `map`. A blob is not converted (the same bytes).
 *
 * @throws CompatObjectConversionError where git's (non-gentle) conversion dies
 */
export async function convertObjectContent(
  type: ObjectTypeString,
  content: Uint8Array,
  from: ObjectFormat,
  to: ObjectFormat,
  map: CompatIdMapper,
): Promise<Uint8Array> {
  if (from.name === to.name || type === "blob") return content;
  try {
    switch (type) {
      case "tree":
        return await convertTree(content, from, to, map);
      case "commit":
        return latin1Bytes(await convertCommit(latin1(content), from, to, map));
      case "tag":
        return latin1Bytes(await convertTag(latin1(content), from, to, map));
      default:
        throw new Refused();
    }
  } catch (e) {
    if (!(e instanceof Refused)) throw e;
    const lines = e.line ? [`error: ${e.line}`] : [];
    lines.push(`fatal: Failed to convert object from ${from.name} to ${to.name}`);
    throw new CompatObjectConversionError(lines);
  }
}

/** The id `content` (an object of `type`) has in `format`: git's `hash_object_file`. */
export function objectIdOf(
  type: ObjectTypeString,
  content: Uint8Array,
  format: ObjectFormat,
): string {
  const header = new TextEncoder().encode(`${type} ${content.length}\0`);
  return bytesToHex(format.hashObject(header, content));
}

/**
 * The compatibility id of an object stored in `from`: its bytes converted to `to` and hashed
 * there (a blob is hashed as it is), as git's `odb_write_object_ext` computes it.
 */
export async function compatObjectIdOf(
  type: ObjectTypeString,
  content: Uint8Array,
  from: ObjectFormat,
  to: ObjectFormat,
  map: CompatIdMapper,
): Promise<string> {
  return objectIdOf(type, await convertObjectContent(type, content, from, to, map), to);
}
