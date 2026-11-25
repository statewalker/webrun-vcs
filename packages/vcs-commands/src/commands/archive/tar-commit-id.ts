/**
 * `git get-tar-commit-id` (builtin/get-tar-commit-id.c): the commit id `git archive` put in
 * a tar archive's pax global header (`comment=<id>`).
 *
 * @example
 * ```typescript
 * const tar = await git.archive().setTree("HEAD").call();
 * getTarCommitId(tar); // { exitCode: 0, output: "<commit id>\n" }
 * ```
 */
import { GitApiError } from "../../errors/index.js";

const RECORDSIZE = 512;
const HEADERSIZE = 2 * RECORDSIZE;
const TYPEFLAG_GLOBAL_HEADER = 0x67;

/** What `git get-tar-commit-id` writes and its exit status. */
export interface TarCommitIdResult {
  /** 0 with the id (and its newline) on stdout, 1 when the archive carries none */
  exitCode: number;
  output: string;
}

const isSpace = (c: number) => c === 0x20 || (c >= 0x09 && c <= 0x0d);
const isDigit = (c: number) => c >= 0x30 && c <= 0x39;

/**
 * The commit id of a tar archive's first bytes (git reads exactly 1024 of its stdin).
 *
 * @throws GitApiError (exit 128) when fewer than 1024 bytes are given, as git dies
 */
export function getTarCommitId(archive: Uint8Array): TarCommitIdResult {
  if (archive.length < HEADERSIZE) {
    // die_errno with errno still 0
    throw new GitApiError("fatal: git get-tar-commit-id: EOF before reading tar header: Success", {
      exitCode: 128,
    });
  }
  const none = { exitCode: 1, output: "" };
  if (archive[156] !== TYPEFLAG_GLOBAL_HEADER) return none;
  // strtol(content, &end, 10) over the second record (NUL-terminated by git's buffer end)
  const content = archive.subarray(RECORDSIZE, HEADERSIZE);
  let i = 0;
  while (i < content.length && isSpace(content[i] as number)) i++;
  let negative = false;
  if (content[i] === 0x2b || content[i] === 0x2d) {
    negative = content[i] === 0x2d;
    i++;
  }
  const digitsStart = i;
  let len = 0;
  while (i < content.length && isDigit(content[i] as number)) {
    len = len * 10 + ((content[i] as number) - 0x30);
    i++;
  }
  if (i === digitsStart || negative) return none;
  if (len > Number.MAX_SAFE_INTEGER) return none;
  const prefix = " comment=";
  for (let k = 0; k < prefix.length; k++) {
    if (content[i + k] !== prefix.charCodeAt(k)) return none;
  }
  const comment = i + prefix.length;
  len -= comment;
  const hashLength = (len - 1) / 2;
  if (len < 1 || len % 2 === 0 || (hashLength !== 20 && hashLength !== 32)) return none;
  let output = "";
  // write_in_full(1, comment, len): bytes up to the buffer's end (git's own buffer is 1024)
  for (let k = comment; k < comment + len && k < content.length; k++) {
    output += String.fromCharCode(content[k] as number);
  }
  return { exitCode: 0, output };
}
