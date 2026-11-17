/**
 * Git commit object format serialization and parsing
 *
 * Commit format:
 *   tree <tree-sha1>
 *   parent <parent-sha1>     (repeated for each parent)
 *   author <name> <email> <timestamp> <timezone>
 *   committer <name> <email> <timestamp> <timezone>
 *   [gpgsig <signature>]     (optional)
 *   [encoding <encoding>]    (optional)
 *
 *   <commit message>
 */

import { toLines } from "@statewalker/vcs-utils";
import { collect } from "@statewalker/vcs-utils/streams";
import { formatPersonIdent, parsePersonIdent } from "../format/person-ident.js";
import type { CommitEntry } from "../format/types.js";
import type { Commit } from "./commits.js";

const LF = "\n";

/**
 * Encode commit entries to byte stream
 *
 * Accepts both sync and async iterables.
 *
 * @param entries Commit entries in order
 * @yields Byte chunks of serialized commit
 */
export async function* encodeCommitEntries(
  entries: AsyncIterable<CommitEntry> | Iterable<CommitEntry>,
): AsyncGenerator<Uint8Array> {
  // Build commit content

  const encoder = new TextEncoder();
  function line(str: string): Uint8Array {
    return encoder.encode(`${str}${LF}`);
  }

  for await (const entry of entries) {
    switch (entry.type) {
      case "tree":
        yield line(`tree ${entry.value}`);
        break;
      case "parent":
        yield line(`parent ${entry.value}`);
        break;
      case "author":
        yield line(`author ${formatPersonIdent(entry.value)}`);
        break;
      case "committer":
        yield line(`committer ${formatPersonIdent(entry.value)}`);
        break;
      case "encoding":
        yield line(`encoding ${entry.value}`);
        break;
      case "gpgsig": {
        // GPG signature with continuation lines
        const sigLines = entry.value.split("\n");
        yield line(`gpgsig ${sigLines[0]}`);
        for (let i = 1; i < sigLines.length; i++) {
          yield line(` ${sigLines[i]}`);
        }
        break;
      }
      case "message":
        // Empty line before message
        yield line("");
        // Emit message as-is — no trailing \n appended
        yield encoder.encode(entry.value);
        break;
    }
  }
}

/**
 * Compute serialized commit size
 *
 * @param entries Commit entries
 * @returns Size in bytes
 */
export async function computeCommitSize(
  entries: AsyncIterable<CommitEntry> | Iterable<CommitEntry>,
): Promise<number> {
  // Collect entries and compute size using encodeCommitEntries
  let size = 0;
  for await (const block of encodeCommitEntries(entries)) {
    size += block.length;
  }
  return size;
}

/**
 * Decode commit entries from byte stream
 *
 * @param input Async byte stream (without header)
 * @yields Commit entries in order
 */
export async function* decodeCommitEntries(
  input: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
): AsyncGenerator<CommitEntry> {
  // keepDelimiter=true preserves trailing "\n" for byte-level round-trip fidelity
  const parser = new CommitLineParser();
  for await (const rawLine of toLines(input, true)) yield* parser.line(rawLine);
  yield* parser.end();
}

/** Shared: `decodeText` only decodes whole texts with it (no state left between calls). */
const wholeTextDecoder = new TextDecoder();

/**
 * The text of a whole commit, decoded as `toLines` decodes a stream: a trailing incomplete
 * UTF-8 sequence is dropped (a streaming decode never flushes it).
 */
function decodeText(data: Uint8Array): string {
  // ending in ASCII (a commit ends in "\n"): nothing is held back, one shared decoder serves
  if (data.length === 0 || (data[data.length - 1] as number) < 0x80)
    return wholeTextDecoder.decode(data);
  return new TextDecoder().decode(data, { stream: true });
}

/**
 * Parse a whole commit held in memory: the commit `entriesToCommit(decodeCommitEntries([data]))`
 * gives, without generators (a rev-walk parses every commit it reads). Throws as it does.
 */
export function commitFromBytes(data: Uint8Array): Commit {
  const text = decodeText(data);
  const builder = new CommitBuilder();
  let gpg: string[] | undefined;
  let at = 0;
  let messageAt = -1;
  while (at < text.length) {
    const nl = text.indexOf("\n", at);
    const lineEnd = nl < 0 ? text.length : nl;
    const next = nl < 0 ? text.length : nl + 1;
    // the line without its "\n" and one "\r" before it
    const stop = lineEnd > at && text.charCodeAt(lineEnd - 1) === 13 ? lineEnd - 1 : lineEnd;
    if (gpg) {
      if (text.charCodeAt(at) === 32 && stop > at) {
        gpg.push(text.slice(at + 1, stop));
        at = next;
        continue;
      }
      builder.add({ type: "gpgsig", value: gpg.join("\n") });
      gpg = undefined;
    }
    if (stop === at) {
      // the empty line: the message follows, raw
      messageAt = next;
      break;
    }
    const space = text.indexOf(" ", at);
    if (space >= 0 && space < stop) {
      const key = text.slice(at, space);
      const value = text.slice(space + 1, stop);
      switch (key) {
        case "tree":
          builder.add({ type: "tree", value });
          break;
        case "parent":
          builder.add({ type: "parent", value });
          break;
        case "author":
          builder.add({ type: "author", value: parsePersonIdent(value) });
          break;
        case "committer":
          builder.add({ type: "committer", value: parsePersonIdent(value) });
          break;
        case "encoding":
          builder.add({ type: "encoding", value });
          break;
        case "gpgsig":
          gpg = [value];
          break;
      }
    }
    at = next;
  }
  if (gpg) builder.add({ type: "gpgsig", value: gpg.join("\n") });
  if (messageAt >= 0) builder.add({ type: "message", value: text.slice(messageAt) });
  return builder.build();
}

/** The line-by-line state of commit decoding (lines with their "\n"). */
class CommitLineParser {
  private inGpgSig = false;
  private readonly gpgSigLines: string[] = [];
  private messageLines: string[] | undefined;

  *line(rawLine: string): Generator<CommitEntry> {
    // Strip line terminator for header parsing
    let line = rawLine;
    if (line.endsWith("\n")) line = line.slice(0, -1);
    if (line.endsWith("\r")) line = line.slice(0, -1);

    // Continuation line for gpgsig
    if (this.inGpgSig) {
      if (line.startsWith(" ")) {
        this.gpgSigLines.push(line.substring(1));
        return;
      }
      // Non-continuation line ends gpgsig
      yield { type: "gpgsig", value: this.gpgSigLines.join("\n") };
      this.inGpgSig = false;
      this.gpgSigLines.length = 0;
    }

    // Empty line marks start of message
    if (line === "" && !this.messageLines) {
      this.messageLines = [];
    } else if (this.messageLines) {
      // Collect raw message lines preserving delimiters
      this.messageLines.push(rawLine);
    } else {
      // Parse header lines
      const spacePos = line.indexOf(" ");
      if (spacePos === -1) return;

      const key = line.substring(0, spacePos);
      const value = line.substring(spacePos + 1);

      switch (key) {
        case "tree":
          yield { type: "tree", value };
          break;
        case "parent":
          yield { type: "parent", value };
          break;
        case "author":
          yield { type: "author", value: parsePersonIdent(value) };
          break;
        case "committer":
          yield { type: "committer", value: parsePersonIdent(value) };
          break;
        case "encoding":
          yield { type: "encoding", value };
          break;
        case "gpgsig":
          this.inGpgSig = true;
          this.gpgSigLines.push(value);
          break;
      }
    }
  }

  *end(): Generator<CommitEntry> {
    // Finalize any ongoing gpgsig
    if (this.inGpgSig) {
      yield { type: "gpgsig", value: this.gpgSigLines.join("\n") };
    }

    // Extract message — raw lines already include delimiters
    if (this.messageLines) {
      const message = this.messageLines.join("");
      yield { type: "message", value: message };
    }
  }
}

/**
 * Convert Commit object to entry stream
 *
 * @param commit Commit object
 * @yields Commit entries
 */
export function* commitToEntries(commit: Commit): Generator<CommitEntry> {
  yield { type: "tree", value: commit.tree };

  for (const parent of commit.parents) {
    yield { type: "parent", value: parent };
  }

  yield { type: "author", value: commit.author };
  yield { type: "committer", value: commit.committer };

  if (commit.encoding && commit.encoding.toLowerCase() !== "utf-8") {
    yield { type: "encoding", value: commit.encoding };
  }

  if (commit.gpgSignature) {
    yield { type: "gpgsig", value: commit.gpgSignature };
  }

  yield { type: "message", value: commit.message };
}

/**
 * Convert entry stream to Commit object
 *
 * @param entries Commit entries
 * @returns Commit object
 */
export async function entriesToCommit(
  entries: AsyncIterable<CommitEntry> | Iterable<CommitEntry>,
): Promise<Commit> {
  const builder = new CommitBuilder();
  for await (const entry of entries) builder.add(entry);
  return builder.build();
}

class CommitBuilder {
  private tree: string | undefined;
  private readonly parents: string[] = [];
  private author: Commit["author"] | undefined;
  private committer: Commit["committer"] | undefined;
  private encoding: string | undefined;
  private gpgSignature: string | undefined;
  private message = "";

  add(entry: CommitEntry): void {
    switch (entry.type) {
      case "tree":
        this.tree = entry.value;
        break;
      case "parent":
        this.parents.push(entry.value);
        break;
      case "author":
        this.author = entry.value;
        break;
      case "committer":
        this.committer = entry.value;
        break;
      case "encoding":
        this.encoding = entry.value;
        break;
      case "gpgsig":
        this.gpgSignature = entry.value;
        break;
      case "message":
        this.message = entry.value;
        break;
    }
  }

  build(): Commit {
    const { tree, author, committer, encoding, gpgSignature } = this;
    if (!tree) {
      throw new Error("Invalid commit: missing tree");
    }
    if (!author) {
      throw new Error("Invalid commit: missing author");
    }
    if (!committer) {
      throw new Error("Invalid commit: missing committer");
    }

    const commit: Commit = {
      tree,
      parents: this.parents,
      author,
      committer,
      message: this.message,
    };

    if (encoding) {
      commit.encoding = encoding;
    }

    if (gpgSignature) {
      commit.gpgSignature = gpgSignature;
    }

    return commit;
  }
}

/**
 * Serialize commit to bytes via streaming internals
 *
 * @param commit Commit object
 * @returns Serialized commit content (without header)
 */
export async function collectCommitBytes(commit: Commit): Promise<Uint8Array> {
  return collect(encodeCommitEntries(commitToEntries(commit)));
}

/**
 * Parse commit from bytes via streaming internals
 *
 * @param data Serialized commit content (without header)
 * @returns Parsed commit object
 */
export async function parseCommitFromBytes(data: Uint8Array): Promise<Commit> {
  return entriesToCommit(decodeCommitEntries([data]));
}

/**
 * Serialize a commit to Git commit format (buffer-based)
 *
 * @param commit Commit object
 * @returns Serialized commit content (without header)
 * @deprecated Use collectCommitBytes or encodeCommitEntries(commitToEntries(commit))
 */
export function serializeCommit(commit: Commit): Uint8Array {
  const encoder = new TextEncoder();
  const lines: string[] = [];

  // tree
  lines.push(`tree ${commit.tree}`);

  // parent(s)
  for (const parent of commit.parents) {
    lines.push(`parent ${parent}`);
  }

  // author
  lines.push(`author ${formatPersonIdent(commit.author)}`);

  // committer
  lines.push(`committer ${formatPersonIdent(commit.committer)}`);

  // encoding (optional)
  if (commit.encoding && commit.encoding.toLowerCase() !== "utf-8") {
    lines.push(`encoding ${commit.encoding}`);
  }

  // gpgsig (optional) - must be formatted with continuation lines
  if (commit.gpgSignature) {
    const sigLines = commit.gpgSignature.split("\n");
    lines.push(`gpgsig ${sigLines[0]}`);
    for (let i = 1; i < sigLines.length; i++) {
      lines.push(` ${sigLines[i]}`);
    }
  }

  // Empty line before message
  lines.push("");

  // Message emitted as-is — no trailing \n appended
  return encoder.encode(`${lines.join(LF)}\n${commit.message}`);
}

/**
 * Parse a commit from Git commit format (buffer-based)
 *
 * @param data Serialized commit content (without header)
 * @returns Parsed commit object
 */
export function parseCommit(data: Uint8Array): Commit {
  const decoder = new TextDecoder();
  const text = decoder.decode(data);

  // Split by LF first, then strip any trailing CR from each line
  const rawLines = text.split(LF);
  const lines = rawLines.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));

  let tree: string | undefined;
  const parents: string[] = [];
  let author: ReturnType<typeof parsePersonIdent> | undefined;
  let committer: ReturnType<typeof parsePersonIdent> | undefined;
  let encoding: string | undefined;
  let gpgSignature: string | undefined;
  let messageStart = -1;

  let inGpgSig = false;
  const gpgSigLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Continuation line for gpgsig
    if (inGpgSig) {
      if (line.startsWith(" ")) {
        gpgSigLines.push(line.substring(1));
        continue;
      }
      gpgSignature = gpgSigLines.join("\n");
      inGpgSig = false;
    }

    // Empty line marks start of message
    if (line === "" && messageStart === -1) {
      messageStart = i + 1;
      break;
    }

    // Parse header lines
    const spacePos = line.indexOf(" ");
    if (spacePos === -1) continue;

    const key = line.substring(0, spacePos);
    const value = line.substring(spacePos + 1);

    switch (key) {
      case "tree":
        tree = value;
        break;
      case "parent":
        parents.push(value);
        break;
      case "author":
        author = parsePersonIdent(value);
        break;
      case "committer":
        committer = parsePersonIdent(value);
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
  if (!tree) {
    throw new Error("Invalid commit: missing tree");
  }
  if (!author) {
    throw new Error("Invalid commit: missing author");
  }
  if (!committer) {
    throw new Error("Invalid commit: missing committer");
  }

  // Extract message — preserve exact content after the empty-line separator
  let message = "";
  {
    const normalizedText = text.replace(/\r\n/g, "\n");
    const sepIdx = normalizedText.indexOf("\n\n");
    if (sepIdx !== -1) {
      message = normalizedText.substring(sepIdx + 2);
    }
  }

  const commit: Commit = {
    tree,
    parents,
    author,
    committer,
    message,
  };

  if (encoding) {
    commit.encoding = encoding;
  }

  if (gpgSignature) {
    commit.gpgSignature = gpgSignature;
  }

  return commit;
}
