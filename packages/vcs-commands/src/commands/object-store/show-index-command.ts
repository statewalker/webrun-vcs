import { SHA1_OBJECT_FORMAT, SHA256_OBJECT_FORMAT } from "@statewalker/vcs-utils/hash";
import { PlumbingCommand, PlumbingError } from "../plumbing-command.js";

const hex = (bytes: Uint8Array) => {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s;
};

/**
 * `git show-index [--object-format=<hash>]` (builtin/show-index.c): reads a pack index (`.idx`
 * version 1 or 2) and prints one line per object in index order: `<offset> <id>` for version 1,
 * `<offset> <id> (<crc32>)` for version 2. Ids are as wide as the repository's object format,
 * or the one `setObjectFormat` names. Dies with git's messages on a short or corrupt index.
 *
 * @example
 * ```typescript
 * const { stdout } = await git.showIndex().setInput(idxBytes).callOutput();
 * ```
 */
export class ShowIndexCommand extends PlumbingCommand {
  private input?: Uint8Array | AsyncIterable<Uint8Array>;
  private hashName?: string;

  /** The index's bytes (git's stdin). */
  setInput(input: Uint8Array | AsyncIterable<Uint8Array>): this {
    this.checkCallable();
    this.input = input;
    return this;
  }

  /** `--object-format=<hash-algorithm>`: `sha1` or `sha256`. */
  setObjectFormat(name: string): this {
    this.checkCallable();
    this.hashName = name;
    return this;
  }

  protected async run(): Promise<number> {
    let format = this.objectFormat;
    if (this.hashName !== undefined) {
      if (this.hashName === "sha1") format = SHA1_OBJECT_FORMAT;
      else if (this.hashName === "sha256") format = SHA256_OBJECT_FORMAT;
      else throw new PlumbingError("fatal: Unknown hash algorithm");
    }
    const raw = format.rawLength;
    const bytes = await this.readInput();
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let at = 0;
    // fread: all or nothing
    const take = (n: number): number | undefined => {
      if (at + n > bytes.length) return undefined;
      const p = at;
      at += n;
      return p;
    };
    if (take(8) === undefined) throw new PlumbingError("fatal: unable to read header");
    let version = 1;
    const top = new Array<number>(256);
    if (view.getUint32(0) === 0xff744f63) {
      version = view.getUint32(4);
      if (version !== 2) throw new PlumbingError("fatal: unknown index version");
      const p = take(256 * 4);
      if (p === undefined) throw new PlumbingError("fatal: unable to read index");
      for (let i = 0; i < 256; i++) top[i] = view.getUint32(p + i * 4);
    } else {
      top[0] = view.getUint32(0);
      top[1] = view.getUint32(4);
      const p = take(254 * 4);
      if (p === undefined) throw new PlumbingError("fatal: unable to read index");
      for (let i = 2; i < 256; i++) top[i] = view.getUint32(p + (i - 2) * 4);
    }
    let nr = 0;
    for (let i = 0; i < 256; i++) {
      const n = top[i] as number;
      if (n < nr) throw new PlumbingError("fatal: corrupt index file");
      nr = n;
    }
    const lines: string[] = [];
    // what git printed before it died is still its stdout
    const die = async (message: string) => {
      await this.write(lines.join(""));
      return new PlumbingError(`fatal: ${message}`);
    };
    if (version === 1) {
      for (let i = 0; i < nr; i++) {
        const p = take(4 + raw);
        if (p === undefined) throw await die(`unable to read entry ${i}/${nr}`);
        lines.push(`${view.getUint32(p)} ${hex(bytes.subarray(p + 4, p + 4 + raw))}\n`);
      }
      await this.write(lines.join(""));
      return 0;
    }
    const ids: number[] = [];
    for (let i = 0; i < nr; i++) {
      const p = take(raw);
      if (p === undefined) throw new PlumbingError(`fatal: unable to read sha1 ${i}/${nr}`);
      ids.push(p);
    }
    const crcs: number[] = [];
    for (let i = 0; i < nr; i++) {
      const p = take(4);
      if (p === undefined) throw new PlumbingError(`fatal: unable to read crc ${i}/${nr}`);
      crcs.push(view.getUint32(p));
    }
    const offsets: number[] = [];
    for (let i = 0; i < nr; i++) {
      const p = take(4);
      if (p === undefined) throw new PlumbingError(`fatal: unable to read 32b offset ${i}/${nr}`);
      offsets.push(view.getUint32(p));
    }
    let large = 0;
    for (let i = 0; i < nr; i++) {
      const off = offsets[i] as number;
      let offset: bigint;
      if (!(off & 0x80000000)) offset = BigInt(off);
      else {
        if ((off & 0x7fffffff) !== large) throw await die("inconsistent 64b offset index");
        const p = take(8);
        if (p === undefined) throw await die(`unable to read 64b offset ${large}`);
        offset = view.getBigUint64(p);
        large++;
      }
      const id = ids[i] as number;
      lines.push(
        `${offset} ${hex(bytes.subarray(id, id + raw))} (${(crcs[i] as number).toString(16).padStart(8, "0")})\n`,
      );
    }
    await this.write(lines.join(""));
    return 0;
  }

  private async readInput(): Promise<Uint8Array> {
    const input = this.input;
    if (input === undefined) return new Uint8Array(0);
    if (input instanceof Uint8Array) return input;
    const parts: Uint8Array[] = [];
    let n = 0;
    for await (const c of input) {
      parts.push(c);
      n += c.length;
    }
    const out = new Uint8Array(n);
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  }
}
