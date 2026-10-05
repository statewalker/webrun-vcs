/**
 * Git annotated tag object format serialization and parsing
 *
 * Tag format:
 *   object <object-sha1>
 *   type <object-type>
 *   tag <tag-name>
 *   tagger <name> <email> <timestamp> <timezone>
 *   [gpgsig <signature>]     (optional)
 *   [encoding <encoding>]    (optional)
 *
 *   <tag message>
 */

import { collect, mapStream, toLines } from "@statewalker/vcs-utils/streams";
import { formatPersonIdent, parsePersonIdent } from "../format/person-ident.js";
import type { TagEntry } from "../format/types.js";
import { typeCodeToString, typeStringToCode } from "../objects/object-header.js";
import type { ObjectTypeCode } from "../objects/object-types.js";
import type { AnnotatedTag } from "./tags.js";

const LF = "\n";

export function serializeTagEntry(entry: TagEntry): string {
  // Build tag content
  switch (entry.type) {
    case "object":
      return `object ${entry.value}\n`;
    case "objectType":
      return `type ${typeCodeToString(entry.value)}\n`;
    case "tag":
      return `tag ${entry.value}\n`;
    case "tagger":
      return `tagger ${formatPersonIdent(entry.value)}\n`;
    case "encoding":
      return `encoding ${entry.value}\n`;
    case "gpgsig": {
      // GPG signature with continuation lines
      const sigLines = entry.value.split("\n");
      const lines = [`gpgsig ${sigLines[0]}\n`];
      for (let i = 1; i < sigLines.length; i++) {
        lines.push(` ${sigLines[i]}\n`);
      }
      return lines.join("");
    }
    case "message":
      // Empty line before message
      return `\n${entry.value}`;
    default: {
      return "";
    }
  }
}

/**
 * Encode tag entries to byte stream
 *
 * Accepts both sync and async iterables.
 *
 * @param entries Tag entries in order
 * @yields Byte chunks of serialized tag
 */
export async function* encodeTagEntries(
  entries: AsyncIterable<TagEntry> | Iterable<TagEntry>,
): AsyncGenerator<Uint8Array> {
  const encoder = new TextEncoder();
  yield* mapStream(entries, (entry) => {
    return encoder.encode(serializeTagEntry(entry));
  });
}

/**
 * Compute serialized tag size
 *
 * @param entries Tag entries
 * @returns Size in bytes
 */
export async function computeTagSize(
  entries: AsyncIterable<TagEntry> | Iterable<TagEntry>,
): Promise<number> {
  let len = 0;
  for await (const entry of encodeTagEntries(entries)) {
    len += entry.length;
  }
  return len;
}

/**
 * Decode tag entries from byte stream
 *
 * @param input Async byte stream (without header)
 * @yields Tag entries in order
 */
export async function* decodeTagEntries(
  input: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
): AsyncGenerator<TagEntry> {
  let inGpgSig = false;
  let inMessage = false;
  const gpgSigLines: string[] = [];
  const messageLines: string[] = [];

  // keepDelimiter=true preserves trailing "\n" for byte-level round-trip fidelity
  for await (const rawLine of toLines(input, true)) {
    // Strip line terminator for header parsing
    let line = rawLine;
    if (line.endsWith("\n")) line = line.slice(0, -1);
    if (line.endsWith("\r")) line = line.slice(0, -1);

    // If we're in message mode, collect raw lines preserving delimiters
    if (inMessage) {
      messageLines.push(rawLine);
      continue;
    }

    // Empty line marks start of message
    if (line === "") {
      // Finalize any ongoing gpgsig
      if (inGpgSig) {
        yield { type: "gpgsig", value: gpgSigLines.join("\n") };
        inGpgSig = false;
        gpgSigLines.length = 0;
      }
      inMessage = true;
      continue;
    }

    // Continuation line for gpgsig
    if (inGpgSig && line.startsWith(" ")) {
      gpgSigLines.push(line.substring(1));
      continue;
    }

    // End of gpgsig if we hit a non-continuation line
    if (inGpgSig) {
      yield { type: "gpgsig", value: gpgSigLines.join("\n") };
      inGpgSig = false;
      gpgSigLines.length = 0;
    }

    // Parse header lines
    const spacePos = line.indexOf(" ");
    if (spacePos === -1) continue;

    const key = line.substring(0, spacePos);
    const value = line.substring(spacePos + 1);

    switch (key) {
      case "object":
        yield { type: "object", value };
        break;
      case "type":
        yield {
          type: "objectType",
          value: typeStringToCode(value as "commit" | "tree" | "blob" | "tag"),
        };
        break;
      case "tag":
        yield { type: "tag", value };
        break;
      case "tagger":
        yield { type: "tagger", value: parsePersonIdent(value) };
        break;
      case "encoding":
        yield { type: "encoding", value };
        break;
      case "gpgsig":
        inGpgSig = true;
        gpgSigLines.push(value);
        break;
    }
  }

  // Finalize any ongoing gpgsig
  if (inGpgSig) {
    yield { type: "gpgsig", value: gpgSigLines.join("\n") };
  }

  // Extract message — raw lines already include delimiters
  if (messageLines.length > 0) {
    const message = messageLines.join("");
    yield { type: "message", value: message };
  }
}

/**
 * Convert AnnotatedTag object to entry stream
 *
 * @param tag AnnotatedTag object
 * @yields Tag entries
 */
export function* tagToEntries(tag: AnnotatedTag): Generator<TagEntry> {
  yield { type: "object", value: tag.object };
  yield { type: "objectType", value: tag.objectType };
  yield { type: "tag", value: tag.tag };

  if (tag.tagger) {
    yield { type: "tagger", value: tag.tagger };
  }

  if (tag.encoding && tag.encoding.toLowerCase() !== "utf-8") {
    yield { type: "encoding", value: tag.encoding };
  }

  if (tag.gpgSignature) {
    yield { type: "gpgsig", value: tag.gpgSignature };
  }

  yield { type: "message", value: tag.message };
}

/**
 * Convert entry stream to AnnotatedTag object
 *
 * @param entries Tag entries
 * @returns AnnotatedTag object
 */
export async function entriesToTag(
  entries: AsyncIterable<TagEntry> | Iterable<TagEntry>,
): Promise<AnnotatedTag> {
  let object: string | undefined;
  let objectType: ObjectTypeCode | undefined;
  let tagName: string | undefined;
  let tagger: AnnotatedTag["tagger"] | undefined;
  let encoding: string | undefined;
  let gpgSignature: string | undefined;
  let message = "";

  for await (const entry of entries) {
    switch (entry.type) {
      case "object":
        object = entry.value;
        break;
      case "objectType":
        objectType = entry.value;
        break;
      case "tag":
        tagName = entry.value;
        break;
      case "tagger":
        tagger = entry.value;
        break;
      case "encoding":
        encoding = entry.value;
        break;
      case "gpgsig":
        gpgSignature = entry.value;
        break;
      case "message":
        message = entry.value;
        break;
    }
  }

  if (!object) {
    throw new Error("Invalid tag: missing object");
  }
  if (objectType === undefined) {
    throw new Error("Invalid tag: missing type");
  }
  if (!tagName) {
    throw new Error("Invalid tag: missing tag name");
  }

  const tag: AnnotatedTag = {
    object,
    objectType,
    tag: tagName,
    message,
  };

  if (tagger) {
    tag.tagger = tagger;
  }

  if (encoding) {
    tag.encoding = encoding;
  }

  if (gpgSignature) {
    tag.gpgSignature = gpgSignature;
  }

  return tag;
}

/**
 * Serialize tag to bytes via streaming internals
 *
 * @param tag Tag object
 * @returns Serialized tag content (without header)
 */
export async function collectTagBytes(tag: AnnotatedTag): Promise<Uint8Array> {
  return collect(encodeTagEntries(tagToEntries(tag)));
}

/**
 * Parse tag from bytes via streaming internals
 *
 * @param data Serialized tag content (without header)
 * @returns Parsed tag object
 */
export async function parseTagFromBytes(data: Uint8Array): Promise<AnnotatedTag> {
  return entriesToTag(decodeTagEntries([data]));
}

/**
 * Serialize an annotated tag to Git tag format (buffer-based)
 *
 * @param tag Tag object
 * @returns Serialized tag content (without header)
 * @deprecated Use collectTagBytes or encodeTagEntries(tagToEntries(tag))
 */
export function serializeTag(tag: AnnotatedTag): Uint8Array {
  const encoder = new TextEncoder();
  const lines: string[] = [];

  // object
  lines.push(`object ${tag.object}`);

  // type
  lines.push(`type ${typeCodeToString(tag.objectType)}`);

  // tag name
  lines.push(`tag ${tag.tag}`);

  // tagger (optional)
  if (tag.tagger) {
    lines.push(`tagger ${formatPersonIdent(tag.tagger)}`);
  }

  // encoding (optional)
  if (tag.encoding && tag.encoding.toLowerCase() !== "utf-8") {
    lines.push(`encoding ${tag.encoding}`);
  }

  // gpgsig (optional) - must be formatted with continuation lines
  if (tag.gpgSignature) {
    const sigLines = tag.gpgSignature.split("\n");
    lines.push(`gpgsig ${sigLines[0]}`);
    for (let i = 1; i < sigLines.length; i++) {
      lines.push(` ${sigLines[i]}`);
    }
  }

  // Empty line before message
  lines.push("");

  // Message
  lines.push(tag.message);

  return encoder.encode(lines.join(LF));
}

/**
 * Parse an annotated tag from Git tag format (buffer-based)
 *
 * @param data Serialized tag content (without header)
 * @returns Parsed tag object
 */
export function parseTag(data: Uint8Array): AnnotatedTag {
  const decoder = new TextDecoder();
  const text = decoder.decode(data);
  const lines = text.split(LF);

  let object: string | undefined;
  let objectType: ObjectTypeCode | undefined;
  let tagName: string | undefined;
  let tagger: ReturnType<typeof parsePersonIdent> | undefined;
  let encoding: string | undefined;
  let gpgSignature: string | undefined;
  let messageStart = -1;

  let inGpgSig = false;
  const gpgSigLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Empty line marks start of message
    if (line === "" && messageStart === -1) {
      if (inGpgSig) {
        gpgSignature = gpgSigLines.join("\n");
        inGpgSig = false;
      }
      messageStart = i + 1;
      break;
    }

    // Continuation line for gpgsig
    if (inGpgSig && line.startsWith(" ")) {
      gpgSigLines.push(line.substring(1));
      continue;
    }

    // End of gpgsig if we hit a non-continuation line
    if (inGpgSig) {
      gpgSignature = gpgSigLines.join("\n");
      inGpgSig = false;
    }

    // Parse header lines
    const spacePos = line.indexOf(" ");
    if (spacePos === -1) continue;

    const key = line.substring(0, spacePos);
    const value = line.substring(spacePos + 1);

    switch (key) {
      case "object":
        object = value;
        break;
      case "type":
        objectType = typeStringToCode(value as "commit" | "tree" | "blob" | "tag");
        break;
      case "tag":
        tagName = value;
        break;
      case "tagger":
        tagger = parsePersonIdent(value);
        break;
      case "encoding":
        encoding = value;
        break;
      case "gpgsig":
        inGpgSig = true;
        gpgSigLines.push(value);
        break;
    }
  }

  // Validate required fields
  if (!object) {
    throw new Error("Invalid tag: missing object");
  }
  if (objectType === undefined) {
    throw new Error("Invalid tag: missing type");
  }
  if (!tagName) {
    throw new Error("Invalid tag: missing tag name");
  }

  // Extract message — preserve exact content after the empty-line separator
  let message = "";
  {
    const sepIdx = text.indexOf("\n\n");
    if (sepIdx !== -1) {
      message = text.substring(sepIdx + 2);
    }
  }

  const tag: AnnotatedTag = {
    object,
    objectType,
    tag: tagName,
    message,
  };

  if (tagger) {
    tag.tagger = tagger;
  }

  if (encoding) {
    tag.encoding = encoding;
  }

  if (gpgSignature) {
    tag.gpgSignature = gpgSignature;
  }

  return tag;
}
