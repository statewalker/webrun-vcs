/**
 * git's remote archive protocol: `git upload-archive` (builtin/upload-archive.c) serving an
 * archive over a stream, and `git archive --remote` (builtin/archive.c's
 * `run_remote_archiver`) asking for one. The archive itself is made by the caller (an
 * {@link UploadArchiveWriter}: `git archive` run in the served repository with the arguments
 * the client sent, as git's `upload-archive--writer`).
 *
 * The exchange: the client sends `argument <arg>` lines and a flush; the server answers `ACK`
 * and a flush, then the writer's stdout on side-band 1 and its stderr on side-band 2, then a
 * flush, or, when the writer failed, `git upload-archive: archiver died with error` on band 3.
 */

import { decodeGitPath, encodeGitPath } from "@statewalker/vcs-utils/encoding";
import { type Duplex, endDuplex } from "../api/duplex.js";
import { PktStream } from "../fetch-client/pkt-stream.js";
import { encodeFlush, encodePacket } from "../protocol/pkt-line-codec.js";
import { encodeSidebandPacket } from "../protocol/sideband.js";

/** What `git archive` in the served repository gave: git's `upload-archive--writer`. */
export interface UploadArchiveOutput {
  /** Its exit status (0 for an archive or a `--list`) */
  exitCode: number;
  /** Its standard output: the archive, or the `--list` lines */
  stdout: Uint8Array;
  /** Its standard error, as git prints it (`fatal: no such ref: x\n`) */
  stderr: string;
}

/**
 * Runs `git archive` in the served repository with the arguments a client sent (git's
 * `upload-archive--writer`, `write_archive(..., remote = 1)`): only formats the server allows
 * remotely, only tree-ishes a ref names unless `uploadarchive.allowUnreachable`.
 */
export type UploadArchiveWriter = (args: string[]) => Promise<UploadArchiveOutput>;

/** git's `MAX_ARGS` of upload-archive.c. */
const MAX_ARGS = 64;
/** upload-archive.c's buffer: side-band packets carry at most this much of the writer's output. */
const CHUNK = 16384;
/** The band-3 error git's upload-archive sends when its writer fails. */
export const ARCHIVER_DIED = "git upload-archive: archiver died with error";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** The outcome of {@link serveUploadArchive}. */
export interface ServeUploadArchiveResult {
  success: boolean;
  /** The arguments the client sent */
  args?: string[];
  /** What git's upload-archive dies with on its own stderr (`sent error to the client: ...`) */
  error?: string;
}

/**
 * Serves one `git-upload-archive` request on `duplex` (the service and repository already
 * chosen: git-daemon's request line read, or a stream opened for it). The stream is not
 * closed.
 *
 * @example
 * ```ts
 * await serveUploadArchive(duplex, (args) => runArchiveWriter(repository, args));
 * ```
 */
export async function serveUploadArchive(
  duplex: Duplex,
  writer: UploadArchiveWriter,
): Promise<ServeUploadArchiveResult> {
  // the parent answers before its writer reads the arguments
  await duplex.write(concat([encodePacket("ACK\n"), encodeFlush()]));
  const input = new PktStream(duplex);
  const args: string[] = [];
  let output: UploadArchiveOutput | undefined;
  try {
    for (;;) {
      const packet = await input.read();
      if (!packet) {
        output = died("the remote end hung up unexpectedly");
        break;
      }
      if (packet.type === "flush") break;
      if (args.length + 1 > MAX_ARGS) {
        output = died(`Too many options (>${MAX_ARGS})`);
        break;
      }
      // git's bytes: a non-UTF-8 pathspec or prefix passes as decodeGitPath's escapes
      let line = packet.type === "data" ? decodeGitPath(packet.data) : "";
      if (line.endsWith("\n")) line = line.slice(0, -1);
      if (packet.type !== "data" || !line.startsWith("argument ")) {
        output = died("'argument' token or flush expected");
        break;
      }
      args.push(line.slice("argument ".length));
    }
  } catch {
    output = died("protocol error: bad line length character");
  }
  output ??= await writer(args).catch(
    (error: unknown): UploadArchiveOutput => died((error as Error).message ?? String(error)),
  );
  try {
    const packets: Uint8Array[] = [];
    for (let at = 0; at < output.stdout.length; at += CHUNK) {
      packets.push(encodeSidebandPacket(1, output.stdout.subarray(at, at + CHUNK)));
    }
    const err = encoder.encode(output.stderr);
    for (let at = 0; at < err.length; at += CHUNK) {
      packets.push(encodeSidebandPacket(2, err.subarray(at, at + CHUNK)));
    }
    if (output.exitCode !== 0) packets.push(encodeSidebandPacket(3, encoder.encode(ARCHIVER_DIED)));
    else packets.push(encodeFlush());
    await duplex.write(concat(packets));
  } catch {
    // the client is gone
  }
  if (output.exitCode !== 0) {
    return { success: false, args, error: `fatal: sent error to the client: ${ARCHIVER_DIED}` };
  }
  return { success: true, args };
}

/** The writer's death (`die()` in upload-archive--writer): stderr, exit 128. */
function died(message: string): UploadArchiveOutput {
  return { exitCode: 128, stdout: new Uint8Array(0), stderr: `fatal: ${message}\n` };
}

/** What `git archive --remote` gave: its stdout, stderr and exit status. */
export interface RemoteArchiveOutput {
  /** 0, 1 when the server reported an error (band 3), 128 when the client died */
  exitCode: number;
  /** The archive (the remote writer's stdout) */
  archive: Uint8Array;
  /**
   * git's stderr: the server's messages as `remote: <line>        ` lines (side-band 2, the
   * suffix git prints when stderr is no terminal), a band-3 error as `remote: <message>`,
   * the client's own `fatal:` line when it died
   */
  stderr: string;
}

/** Options of {@link requestRemoteArchive}. */
export interface RemoteArchiveOptions {
  /**
   * The format `-o <file>`'s name suggests (archive.c's `archive_format_from_filename`): sent
   * first as `--format=<format>`, so an explicit `--format` overrides it
   */
  formatHint?: string;
}

/**
 * Asks the upload-archive at the other end of `duplex` for an archive (builtin/archive.c's
 * `run_remote_archiver`): `args` are `git archive`'s arguments without `--remote`, `--exec`
 * and `--output`. The stream is ended after the request and not closed.
 *
 * @example
 * ```ts
 * const { archive, exitCode } = await requestRemoteArchive(duplex, ["--format=zip", "HEAD"]);
 * ```
 */
export async function requestRemoteArchive(
  duplex: Duplex,
  args: readonly string[],
  options: RemoteArchiveOptions = {},
): Promise<RemoteArchiveOutput> {
  const request: Uint8Array[] = [];
  const line = (arg: string) => encodePacket(encodeGitPath(`argument ${arg}\n`));
  if (options.formatHint) request.push(line(`--format=${options.formatHint}`));
  for (const arg of args) request.push(line(arg));
  request.push(encodeFlush());
  await duplex.write(concat(request));
  await endDuplex(duplex);

  const input = new PktStream(duplex);
  const chunks: Uint8Array[] = [];
  let stderr = "";
  const archive = () => concat(chunks);
  const die = (message: string): RemoteArchiveOutput => ({
    exitCode: 128,
    archive: archive(),
    stderr: `${stderr}fatal: ${message}\n`,
  });
  try {
    const ack = await input.read();
    if (!ack) return die("the remote end hung up unexpectedly");
    if (ack.type !== "data") return die("git archive: expected ACK/NAK, got a flush packet");
    if (ack.text.startsWith("ERR ")) return die(`remote error: ${ack.text.slice(4)}`);
    if (ack.text !== "ACK") {
      if (ack.text.startsWith("NACK ")) return die(`git archive: NACK ${ack.text.slice(5)}`);
      return die("git archive: protocol error");
    }
    const flush = await input.read();
    if (!flush) return die("the remote end hung up unexpectedly");
    if (flush.type !== "flush") return die("git archive: expected a flush");

    // recv_sideband: band 1 to stdout, band 2 as `remote: ` lines, band 3 ends with an error
    let scratch = "";
    const flushScratch = () => {
      if (scratch) stderr += `${scratch}\n`;
      scratch = "";
    };
    for (;;) {
      const packet = await input.read();
      if (!packet) {
        flushScratch();
        return die("the remote end hung up unexpectedly");
      }
      if (packet.type !== "data") {
        flushScratch();
        return { exitCode: 0, archive: archive(), stderr };
      }
      if (packet.data.length === 0) continue;
      const band = packet.data[0];
      const payload = packet.data.subarray(1);
      if (band === 1) chunks.push(payload.slice());
      else if (band === 2) {
        let text = decoder.decode(payload);
        for (;;) {
          const brk = text.search(/[\n\r]/);
          if (brk < 0) break;
          if (!scratch) scratch = "remote: ";
          if (brk > 0) scratch += `${text.slice(0, brk)}        `;
          stderr += `${scratch}${text[brk]}`;
          scratch = "";
          text = text.slice(brk + 1);
        }
        if (text) scratch = `${scratch || "remote: "}${text}`;
      } else if (band === 3) {
        stderr += `${scratch ? `${scratch}\n` : ""}remote: ${decoder.decode(payload)}\n`;
        scratch = "";
        return { exitCode: 1, archive: archive(), stderr };
      } else {
        stderr += `${scratch ? `${scratch}\n` : ""}archive: protocol error: bad band #${band}\n`;
        scratch = "";
        return { exitCode: 1, archive: archive(), stderr };
      }
    }
  } catch (error) {
    return die((error as Error).message);
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0];
  let length = 0;
  for (const p of parts) length += p.length;
  const out = new Uint8Array(length);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
