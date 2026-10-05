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
  const rawLines = toLines(input, true);

  let inGpgSig = false;
  const gpgSigLines: string[] = [];
  let messageLines: string[] | undefined;

  for await (const rawLine of rawLines) {
    // Strip line terminator for header parsing
    let line = rawLine;
    if (line.endsWith("\n")) line = line.slice(0, -1);
    if (line.endsWith("\r")) line = line.slice(0, -1);

    // Continuation line for gpgsig
    if (inGpgSig) {
      if (line.startsWith(" ")) {
        gpgSigLines.push(line.substring(1));
        continue;
      }
      // Non-continuation line ends gpgsig
      yield { type: "gpgsig", value: gpgSigLines.join("\n") };
      inGpgSig = false;
      gpgSigLines.length = 0;
    }

    // Empty line marks start of message
    if (line === "" && !messageLines) {
      messageLines = [];
    } else if (messageLines) {
      // Collect raw message lines preserving delimiters
      messageLines.push(rawLine);
    } else {
      // Parse header lines
      const spacePos = line.indexOf(" ");
      if (spacePos === -1) continue;

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
          inGpgSig = true;
          gpgSigLines.push(value);
          break;
      }
    }
  }

  // Finalize any ongoing gpgsig
  if (inGpgSig) {
    yield { type: "gpgsig", value: gpgSigLines.join("\n") };
  }

  // Extract message — raw lines already include delimiters
  if (messageLines) {
    const message = messageLines.join("");
    yield { type: "message", value: message };
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
  let tree: string | undefined;
  const parents: string[] = [];
  let author: Commit["author"] | undefined;
  let committer: Commit["committer"] | undefined;
  let encoding: string | undefined;
  let gpgSignature: string | undefined;
  let message = "";

  for await (const entry of entries) {
    switch (entry.type) {
      case "tree":
        tree = entry.value;
        break;
      case "parent":
        parents.push(entry.value);
        break;
      case "author":
        author = entry.value;
        break;
      case "committer":
        committer = entry.value;
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
