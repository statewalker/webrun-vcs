/**
 * What a git server learns before it runs a service: git-daemon's request line (daemon.c's
 * `execute`, `parse_extra_args`, `parse_host_arg`), the `GIT_PROTOCOL` parameters
 * (protocol.c's `determine_protocol_version_server`), and the command an ssh session runs
 * (`git-upload-pack '<path>'`, shell-quoted as git's quote.c `sq_quote_buf` writes it).
 *
 * @example
 * ```ts
 * const { request, input } = await readGitDaemonRequest(duplex);
 * // request: { command: "git-upload-pack", path: "/r.git", host: "example.com", gitProtocol: "version=2" }
 * // input: the bytes after the request line, nothing lost
 * ```
 */

import { ChunkQueue } from "./chunk-queue.js";
import { MAX_PACKET_SIZE } from "./constants.js";

/** git-daemon's request line, read as daemon.c reads it. */
export interface GitDaemonRequest {
  /** The command word (`git-upload-pack`, `git-receive-pack`, `git-upload-archive`, ...) */
  command: string;
  /** The directory asked for, as sent (everything after the first space) */
  path: string;
  /** The `host=` value's host, canonicalized as git-daemon does (lowercase, no `/`, no leading dots) */
  host?: string;
  /** The `host=` value's port, when it names one */
  port?: string;
  /** The parameters after the second NUL joined with `:` (git-daemon's `GIT_PROTOCOL`) */
  gitProtocol?: string;
}

/** A request line git-daemon would refuse; `reason` is its log text or death message. */
export class GitDaemonRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitDaemonRequestError";
  }
}

/** daemon.c's `sanitize_client`: directory separators dropped, leading and doubled dots too. */
function sanitizeClient(input: string): string {
  let out = "";
  for (const ch of input) {
    if (ch === "/") continue;
    if (ch === "." && (out.length === 0 || out.endsWith("."))) continue;
    out += ch;
  }
  return out.replace(/\.+$/, "");
}

/** daemon.c's `parse_host_and_port`. */
function parseHostAndPort(value: string): { host: string; port?: string } {
  if (value.startsWith("[")) {
    const end = value.indexOf("]");
    if (end < 0) throw new GitDaemonRequestError("Invalid request ('[' without ']')");
    const host = value.slice(1, end);
    const after = value.slice(end + 1);
    if (after === "") return { host };
    if (after.startsWith(":")) return { host, port: after.slice(1) };
    throw new GitDaemonRequestError("Garbage after end of host part");
  }
  const colon = value.lastIndexOf(":");
  return colon < 0
    ? { host: value }
    : { host: value.slice(0, colon), port: value.slice(colon + 1) };
}

/**
 * Parses git-daemon's request (the payload of its first pkt-line) as daemon.c does: the line up
 * to the first NUL (a trailing LF dropped) is `<command> <path>`; after it an optional
 * `host=<host>[:<port>]` field, then, after a second NUL, parameters joined into
 * `GIT_PROTOCOL`. A field after `host=` that is not behind the second NUL, or a first field
 * other than `host=`, is git-daemon's "Invalid request".
 *
 * @throws GitDaemonRequestError for a request git-daemon dies on or refuses (no command word)
 */
export function parseGitDaemonRequest(payload: Uint8Array): GitDaemonRequest {
  const text = new TextDecoder().decode(payload);
  const nul = text.indexOf("\0");
  let line = nul < 0 ? text : text.slice(0, nul);
  if (line.endsWith("\n")) line = line.slice(0, -1);
  const request: Partial<GitDaemonRequest> = {};

  if (nul >= 0) {
    // parse_extra_args over the bytes after the line's NUL
    const fields = text.slice(nul + 1).split("\0");
    // the payload ends with a NUL: its last (empty) field is no field
    if (text.endsWith("\0")) fields.pop();
    let at = 0;
    const first = fields[0];
    if (first !== undefined && first !== "") {
      if (first.slice(0, 5).toLowerCase() === "host=") {
        const value = first.slice(5);
        if (value) {
          const { host, port } = parseHostAndPort(value);
          if (port !== undefined) request.port = sanitizeClient(port);
          request.host = sanitizeClient(host).toLowerCase();
        }
        at = 1;
      }
      const next = fields[at];
      if (next !== undefined && next !== "") throw new GitDaemonRequestError("Invalid request");
    }
    const params = fields.slice(at).filter((f) => f !== "");
    if (params.length > 0) request.gitProtocol = params.join(":");
  }

  const match = /^(git-[^ ]+) (.*)$/s.exec(line);
  if (!match) throw new GitDaemonRequestError(`Protocol error: '${line}'`);
  return {
    command: match[1] as string,
    path: match[2] as string,
    ...(request.host !== undefined ? { host: request.host } : {}),
    ...(request.port !== undefined ? { port: request.port } : {}),
    ...(request.gitProtocol !== undefined ? { gitProtocol: request.gitProtocol } : {}),
  };
}

/**
 * The input after the request line: what was read past it first, then the rest of the stream.
 * Every iteration reads from the one underlying iterator, and leaving one early (a `for await`
 * that breaks) does not end it: the stream's reader is shared, as a duplex's is.
 */
function remainder(
  queue: ChunkQueue,
  iterator: AsyncIterator<Uint8Array>,
): AsyncIterable<Uint8Array> {
  let leftover: Uint8Array | undefined = queue.length > 0 ? queue.drain() : undefined;
  return {
    [Symbol.asyncIterator]: () => {
      let done = false;
      return {
        async next(): Promise<IteratorResult<Uint8Array>> {
          if (done) return { value: undefined, done: true };
          if (leftover) {
            const value = leftover;
            leftover = undefined;
            return { value, done: false };
          }
          return iterator.next();
        },
        async return(): Promise<IteratorResult<Uint8Array>> {
          done = true;
          return { value: undefined, done: true };
        },
      };
    },
  };
}

/**
 * Reads git-daemon's request line, the first pkt-line of the stream (git's `packet_read` into
 * a {@link MAX_PACKET_SIZE} buffer: a longer one, a flush or a malformed length is refused),
 * and parses it ({@link parseGitDaemonRequest}). The bytes the peer sent after it are not
 * lost: `input` yields them first, then the rest of the stream.
 *
 * @throws GitDaemonRequestError for a request git-daemon would refuse or a stream that ends first
 */
export async function readGitDaemonRequest(input: AsyncIterable<Uint8Array>): Promise<{
  request: GitDaemonRequest;
  input: AsyncIterable<Uint8Array>;
}> {
  const iterator = input[Symbol.asyncIterator]();
  const queue = new ChunkQueue();
  while (true) {
    if (queue.length >= 4) {
      const header = queue.peekHeader();
      if (!/^[0-9a-fA-F]{4}$/.test(header)) {
        throw new GitDaemonRequestError("protocol error: bad line length character");
      }
      const length = Number.parseInt(header, 16);
      if (length < 4) throw new GitDaemonRequestError("Protocol error: ''");
      if (length > MAX_PACKET_SIZE) {
        throw new GitDaemonRequestError(`protocol error: bad line length ${length}`);
      }
      if (queue.length >= length) {
        queue.take(4);
        const payload = queue.take(length - 4);
        return { request: parseGitDaemonRequest(payload), input: remainder(queue, iterator) };
      }
    }
    const next = await iterator.next();
    if (next.done) throw new GitDaemonRequestError("the peer hung up before its request");
    queue.push(next.value);
  }
}

/** What a `GIT_PROTOCOL` value asks for. */
export interface GitProtocolParameters {
  /** The greatest `version=<n>` (0, 1 or 2) among the parameters; 0 when none names one */
  version: 0 | 1 | 2;
  /** Every parameter, in order */
  params: string[];
}

/**
 * Reads a `GIT_PROTOCOL` value (`version=2:key=value`) as git's servers do
 * (`determine_protocol_version_server`): its `:`-separated parameters, the protocol the
 * greatest `version=` asks for (an unknown version ignored).
 *
 * @example
 * ```ts
 * parseGitProtocolEnv("version=1:version=2"); // { version: 2, params: ["version=1", "version=2"] }
 * parseGitProtocolEnv(undefined);             // { version: 0, params: [] }
 * ```
 */
export function parseGitProtocolEnv(value: string | undefined): GitProtocolParameters {
  const params = value ? value.split(":") : [];
  let version: 0 | 1 | 2 = 0;
  for (const param of params) {
    if (!param.startsWith("version=")) continue;
    const v = param.slice(8);
    if ((v === "1" || v === "2") && Number(v) > version) version = Number(v) as 1 | 2;
  }
  return { version, params };
}

/**
 * Shell-quotes a word as git's `sq_quote_buf` does: in single quotes, a `'` or `!` written as
 * `'\''` / `'\!'`.
 *
 * @example
 * ```ts
 * sqQuote("it's"); // "'it'\\''s'"
 * ```
 */
export function sqQuote(word: string): string {
  return `'${word.replace(/['!]/g, (ch) => `'\\${ch}'`)}'`;
}

/**
 * Undoes git's shell quoting (quote.c's `sq_dequote_step`, as git-shell reads the command an
 * ssh session asks for): single-quoted words, a `\'` or `\!` between them, adjacent pieces
 * joined; whitespace separates words. Undefined for text git's quoting never writes.
 */
export function sqDequoteWords(text: string): string[] | undefined {
  const words: string[] = [];
  let i = 0;
  while (i < text.length) {
    while (text[i] === " ") i++;
    if (i >= text.length) break;
    if (text[i] !== "'") return undefined;
    let word = "";
    while (true) {
      if (text[i] !== "'") return undefined;
      const close = text.indexOf("'", i + 1);
      if (close < 0) return undefined;
      word += text.slice(i + 1, close);
      i = close + 1;
      if (text[i] === "\\" && (text[i + 1] === "'" || text[i + 1] === "!")) {
        word += text[i + 1];
        i += 2;
        continue;
      }
      if (i >= text.length || text[i] === " ") break;
      return undefined;
    }
    words.push(word);
  }
  return words;
}

/** The command an ssh session runs for git: `git-upload-pack '<path>'` (or `git upload-pack`). */
export interface GitServiceCommand {
  /** `git-upload-pack`, `git-receive-pack`, `git-upload-archive` */
  service: string;
  /** The repository's path, unquoted */
  path: string;
}

/**
 * Reads the command git's ssh transport sends (`git-upload-pack '/srv/r.git'`, as
 * connect.c builds it), as git-shell accepts it: the program `git-<service>` or
 * `git <service>`, then one shell-quoted argument.
 *
 * @example
 * ```ts
 * parseGitServiceCommand("git-receive-pack '~/r.git'"); // { service: "git-receive-pack", path: "~/r.git" }
 * parseGitServiceCommand("rm -rf /");                    // undefined
 * ```
 */
export function parseGitServiceCommand(command: string): GitServiceCommand | undefined {
  const m = /^git[ -](upload-pack|receive-pack|upload-archive) (.*)$/s.exec(command);
  if (!m) return undefined;
  const words = sqDequoteWords(m[2] as string);
  if (words?.length !== 1) return undefined;
  return { service: `git-${m[1]}`, path: words[0] as string };
}
