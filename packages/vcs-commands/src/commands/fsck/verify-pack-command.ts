import type { FilesApi } from "@statewalker/vcs-core";

import { GitCommand } from "../../git-command.js";
import { scanPack, unpackEntry } from "./fsck-pack.js";

/** One object of a pack, as `git verify-pack -v` lists it. */
export interface VerifyPackObject {
  id: string;
  /** The object's type (a delta's resolved type). */
  type: string;
  /** The size in the entry's header: the object's, or the delta data's. */
  size: number;
  /** Bytes the entry takes in the pack. */
  sizeInPack: number;
  offset: number;
  /** For a delta: its depth in the chain (1 for a delta of a whole object) and its base. */
  depth?: number;
  baseId?: string;
}

/** What one pack verified to. */
export interface VerifyPackReport {
  /** The pack's path, normalized to `<name>.pack`. */
  pack: string;
  ok: boolean;
  /** The objects in pack order (when the pack could be read). */
  objects: VerifyPackObject[];
  /** Objects that are not deltas. */
  nonDelta: number;
  /** Objects per delta chain length (index 0: chain length 1). */
  chainLengths: number[];
  /** What went wrong, as messages. */
  errors: string[];
}

/** Result of `git verify-pack`. */
export interface VerifyPackResult {
  /** 0 when every pack is sound, 1 otherwise (git's exit status). */
  exitCode: number;
  packs: VerifyPackReport[];
  /** What git prints on stdout. */
  output: string;
  /** What git prints on stderr. */
  errorOutput: string;
}

/**
 * Verify packs, as `git verify-pack` does: the idx's and the pack's checksums, each entry's
 * CRC-32, and every object unpacked and re-hashed.
 *
 * With `setVerbose(true)` (`-v`) each object is listed in pack order as
 * `<id> <type> <size> <size-in-pack> <offset> [<depth> <base-id>]`, then the number of whole
 * objects (`non delta: N objects`) and of deltas per chain length
 * (`chain length = N: M objects`), then `<pack>.pack: ok` (or `: bad`). With
 * `setStatOnly(true)` (`-s`) only the counts are printed. Without either, only errors are.
 *
 * git runs `index-pack --verify` for this; when a pack is bad, the messages here are the
 * checks' own, not index-pack's (`fatal: pack has bad object at offset ...`).
 *
 * @example
 * ```typescript
 * const result = await git.verifyPack()
 *   .setRepositoryFiles({ files })
 *   .addPack(".git/objects/pack/pack-1234.idx")
 *   .setVerbose(true)
 *   .call();
 * process.stdout.write(result.output);
 * ```
 */
export class VerifyPackCommand extends GitCommand<VerifyPackResult> {
  private _files?: FilesApi;
  private readonly _packs: string[] = [];
  private _verbose = false;
  private _statOnly = false;

  /** The files the pack paths are read from. */
  setRepositoryFiles(repository: { files: FilesApi }): this {
    this.checkCallable();
    this._files = repository.files;
    return this;
  }

  /** A pack to verify: `<name>.idx`, `<name>.pack` or `<name>`. */
  addPack(path: string): this {
    this.checkCallable();
    this._packs.push(path);
    return this;
  }

  /** `-v`: list every object and the delta chain histogram. */
  setVerbose(verbose: boolean): this {
    this.checkCallable();
    this._verbose = verbose;
    return this;
  }

  /** `-s`: print only the histogram. */
  setStatOnly(statOnly: boolean): this {
    this.checkCallable();
    this._statOnly = statOnly;
    return this;
  }

  async call(): Promise<VerifyPackResult> {
    this.checkCallable();
    this.setCallable(false);
    const files = this._files;
    if (!files) throw new Error("verify-pack needs the repository's files (setRepositoryFiles)");
    const out: string[] = [];
    const err: string[] = [];
    const packs: VerifyPackReport[] = [];
    let exitCode = 0;
    for (const path of this._packs) {
      const base = path.endsWith(".idx")
        ? path.slice(0, -4)
        : path.endsWith(".pack")
          ? path.slice(0, -5)
          : path;
      const report = await verifyOnePack(files, `${base}.pack`, `${base}.idx`);
      packs.push(report);
      for (const e of report.errors) err.push(`${e}\n`);
      if (report.ok && (this._verbose || this._statOnly)) {
        if (!this._statOnly) {
          for (const o of report.objects) {
            let line = `${o.id} ${o.type.padEnd(6)} ${o.size} ${o.sizeInPack} ${o.offset}`;
            if (o.depth !== undefined) line += ` ${o.depth} ${o.baseId}`;
            out.push(`${line}\n`);
          }
        }
        if (report.nonDelta) {
          out.push(`non delta: ${report.nonDelta} object${report.nonDelta === 1 ? "" : "s"}\n`);
        }
        report.chainLengths.forEach((count, i) => {
          if (count)
            out.push(`chain length = ${i + 1}: ${count} object${count === 1 ? "" : "s"}\n`);
        });
      }
      if (this._verbose || this._statOnly) {
        if (!report.ok) out.push(`${report.pack}: bad\n`);
        else if (!this._statOnly) out.push(`${report.pack}: ok\n`);
      }
      if (!report.ok) exitCode = 1;
    }
    return { exitCode, packs, output: out.join(""), errorOutput: err.join("") };
  }
}

async function verifyOnePack(
  files: FilesApi,
  packPath: string,
  idxPath: string,
): Promise<VerifyPackReport> {
  const errors: string[] = [];
  const report: VerifyPackReport = {
    pack: packPath,
    ok: false,
    objects: [],
    nonDelta: 0,
    chainLengths: [],
    errors,
  };
  const scan = await scanPack(files, packPath, idxPath, (m) => errors.push(`error: ${m}`));
  const pack = scan.pack;
  if (!pack) return report;
  let ok = !scan.failed;
  try {
    const depthOf = new Map<string, number>();
    const baseOf = new Map<string, string | undefined>();
    for (const entry of scan.entries) {
      if (!entry.crcOk) {
        errors.push(
          `error: index CRC mismatch for object ${entry.id} from ${packPath} at offset ${entry.offset}`,
        );
        ok = false;
      }
      const stored = await pack.entry(entry.id);
      const unpacked = await unpackEntry(pack, packPath, entry, () => false);
      if (!stored || "error" in unpacked) {
        errors.push(`error: ${"error" in unpacked ? unpacked.error : `cannot read ${entry.id}`}`);
        ok = false;
        continue;
      }
      baseOf.set(entry.id, stored.baseId);
      report.objects.push({
        id: entry.id,
        type: unpacked.type,
        size: stored.size,
        sizeInPack: entry.sizeInPack,
        offset: entry.offset,
        baseId: stored.baseId,
      });
    }
    // delta depths: a delta of a whole object is 1, a delta of a delta one more
    const depth = (id: string): number => {
      const stack: string[] = [];
      let at = id;
      while (!depthOf.has(at)) {
        const base = baseOf.get(at);
        if (base === undefined) depthOf.set(at, 0);
        else if (!baseOf.has(base)) depthOf.set(at, 1);
        else {
          stack.push(at);
          at = base;
        }
      }
      let d = depthOf.get(at) as number;
      for (let x = stack.pop(); x !== undefined; x = stack.pop()) depthOf.set(x, ++d);
      return depthOf.get(id) as number;
    };
    for (const o of report.objects) {
      if (o.baseId === undefined) {
        report.nonDelta++;
        continue;
      }
      o.depth = depth(o.id);
      report.chainLengths[o.depth - 1] = (report.chainLengths[o.depth - 1] ?? 0) + 1;
    }
    for (let i = 0; i < report.chainLengths.length; i++) report.chainLengths[i] ??= 0;
  } finally {
    pack.close();
  }
  report.ok = ok;
  return report;
}
