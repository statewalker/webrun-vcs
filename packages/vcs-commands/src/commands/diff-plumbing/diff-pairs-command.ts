/**
 * `git diff-pairs -z [<diff-options>]` (builtin/diff-pairs.c, git 2.50 and later): the pairs
 * of a raw diff read back (`git diff-tree -r -z` output) and shown in any diff format.
 *
 * ```typescript
 * const raw = await git.diffTree().addArgument("base").addArgument("new")
 *   .setRecursive(true).setNullTerminated(true).call();
 * const patch = await git.diffPairs().setNullTerminated(true).setInput(raw)
 *   .setFormats(["patch"]).call();
 * ```
 */

import type { FileModeValue } from "@statewalker/vcs-core";
import { decodeGitPath } from "@statewalker/vcs-utils/encoding";

import { GitApiError } from "../../errors/index.js";
import { ChangeType, type DiffEntry } from "../../results/diff-entry.js";
import { DiffPlumbingCommand } from "./diff-plumbing-command.js";

/**
 * Show the pairs of a NUL-terminated raw diff (`setInput`, git's stdin): each record
 * `:<mode> <mode> <id> <id> <status>[<score>]` followed by its path (two for a rename or a
 * copy), in the patch format unless another is asked for. A lone NUL flushes the pairs read
 * so far, followed by a NUL in the output. The renames and copies of the input are kept
 * unless `-M`/`-C` asks to detect them again; trees, pathspecs and input without `-z` are
 * refused as git refuses them.
 */
export class DiffPairsCommand extends DiffPlumbingCommand {
  private input: Uint8Array = new Uint8Array(0);

  /** The raw diff read (git's stdin) */
  setInput(input: string | Uint8Array): this {
    this.checkCallable();
    this.input = typeof input === "string" ? new TextEncoder().encode(input) : input;
    return this;
  }

  async call(): Promise<Uint8Array> {
    this.checkCallable();
    this.setCallable(false);
    if (!this.textOptions.nullTerminated) {
      throw new GitApiError("usage: working without -z is not supported", { exitCode: 129 });
    }
    if (this.pathspec.length > 0) {
      throw new GitApiError("usage: pathspec arguments not supported", { exitCode: 129 });
    }
    const formats = this.outputFormats("patch");
    const fields = splitNul(this.input);
    const out: Uint8Array[] = [];
    let queue: DiffEntry[] = [];
    const flush = async () => {
      const entries = queue;
      queue = [];
      if (entries.length === 0) return;
      const o = this.textOptions;
      const detect =
        (o.findRenames !== undefined && o.findRenames !== false) ||
        (o.findCopies !== undefined && o.findCopies !== false);
      const diff = this.diffCommand().setQueue(entries, { diffcore: detect || !!o.breakRewrites });
      out.push(await this.printed(diff, formats));
    };
    const nullId = this.objectFormat.nullId;
    const hexLength = this.objectFormat.hexLength;
    let k = 0;
    while (k < fields.length) {
      const meta = fields[k++] as Uint8Array;
      if (meta.length === 0) {
        await flush();
        out.push(new Uint8Array([0]));
        continue;
      }
      const text = latin1(meta);
      if (text[0] !== ":") throw fatal("invalid raw diff input");
      let p = 1;
      const mode = () => {
        const m = /^([0-7]+) /.exec(text.slice(p));
        if (!m) throw fatal(`unable to parse mode: ${text.slice(p)}`);
        p += m[0].length;
        return Number.parseInt(m[1] as string, 8);
      };
      const id = () => {
        const hex = text.slice(p, p + hexLength);
        if (!/^[0-9a-f]+$/.test(hex) || hex.length !== hexLength || text[p + hexLength] !== " ") {
          throw fatal(`unable to parse object id: ${text.slice(p)}`);
        }
        p += hexLength + 1;
        return hex;
      };
      const modeA = mode();
      const modeB = mode();
      if ((modeA & 0o170000) === 0o040000 || (modeB & 0o170000) === 0o040000) {
        throw fatal("tree objects not supported");
      }
      const idA = id();
      const idB = id();
      const status = text[p];
      const rest = text.slice(p + 1);
      if (k >= fields.length) throw fatal("got EOF while reading path");
      const path = decodeGitPath(fields[k++] as Uint8Array);
      switch (status) {
        case "A":
          queue.push({
            changeType: ChangeType.ADD,
            newPath: path,
            newId: idB,
            newMode: modeB as FileModeValue,
          });
          break;
        case "D":
          queue.push({
            changeType: ChangeType.DELETE,
            oldPath: path,
            oldId: idA,
            oldMode: modeA as FileModeValue,
          });
          break;
        case "M":
        case "T":
          queue.push({
            changeType: ChangeType.MODIFY,
            oldPath: path,
            newPath: path,
            oldId: idA,
            newId: idB,
            oldMode: modeA as FileModeValue,
            newMode: modeB as FileModeValue,
            ...(idB === nullId ? { newIdNull: true } : {}),
          });
          break;
        case "R":
        case "C": {
          if (k >= fields.length) throw fatal("got EOF while reading destination path");
          const dst = decodeGitPath(fields[k++] as Uint8Array);
          if (!/^[0-9]+$/.test(rest)) throw fatal(`unable to parse rename/copy score: ${rest}`);
          queue.push({
            changeType: status === "R" ? ChangeType.RENAME : ChangeType.COPY,
            oldPath: path,
            newPath: dst,
            oldId: idA,
            newId: idB,
            oldMode: modeA as FileModeValue,
            newMode: modeB as FileModeValue,
            score: Number(rest),
          });
          break;
        }
        default:
          throw fatal(`unknown diff status: ${status}`);
      }
    }
    await flush();
    return concat(out);
  }
}

function fatal(message: string): GitApiError {
  return new GitApiError(`fatal: ${message}`, { exitCode: 128 });
}

/**
 * strbuf_getwholeline with a NUL terminator: the fields, each without its NUL (a last field
 * without one is still read)
 */
function splitNul(bytes: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = [];
  let start = 0;
  for (let i = 0; i < bytes.length; i++) {
    if (bytes[i] === 0) {
      out.push(bytes.subarray(start, i));
      start = i + 1;
    }
  }
  if (start < bytes.length) out.push(bytes.subarray(start));
  return out;
}

function latin1(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return s;
}

function concat(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
