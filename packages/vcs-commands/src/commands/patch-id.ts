/**
 * git's patch-id of a commit (`commit_patch_id`, `diff_get_patch_id`): the diff against its
 * parent (no rename detection), each file's header and diff lines with whitespace removed,
 * hashed per file and summed, so the order of the files does not matter. Two commits with
 * the same patch-id make the same change: `rebase` leaves out the commits whose change
 * upstream already has (`--cherry-mark`).
 */

import { type Blobs, compareTreeEntries, FileMode, type ObjectId } from "@statewalker/vcs-core";
import {
  bytesToHex,
  type Hasher,
  type ObjectFormat,
  SHA1_OBJECT_FORMAT,
  unifiedDiffHunks,
} from "@statewalker/vcs-utils";
import { encodeGitPath } from "@statewalker/vcs-utils/encoding";

import type { CommandTrees } from "../git-command.js";
import { readBlob } from "./ort-merge.js";

const encoder = new TextEncoder();
const S_IFMT = 0o170000;

/** The trees a patch-id reads (a cache of them serves as well). */
export type PatchIdTrees = Pick<CommandTrees, "loadTree">;

interface Change {
  path: string;
  old?: { mode: number; id: ObjectId };
  new?: { mode: number; id: ObjectId };
}

/** The files two trees differ in (diff_tree_oid, recursive), in path order. */
async function treeChanges(
  trees: PatchIdTrees,
  oldTree: ObjectId | undefined,
  newTree: ObjectId | undefined,
  prefix = "",
  out: Change[] = [],
): Promise<Change[]> {
  const load = async (id: ObjectId | undefined) => {
    const map = new Map<string, { mode: number; id: ObjectId }>();
    if (id) for await (const e of trees.loadTree(id)) map.set(e.name, { mode: e.mode, id: e.id });
    return map;
  };
  const a = await load(oldTree);
  const b = await load(newTree);
  // tree order (git's base_name_compare): a directory sorts as `name/`
  const entry = (name: string) => ({ name, mode: (b.get(name) ?? a.get(name))?.mode ?? 0 });
  const names = [...new Set([...a.keys(), ...b.keys()])].sort((x, y) =>
    compareTreeEntries(entry(x), entry(y)),
  );
  for (const name of names) {
    const x = a.get(name);
    const y = b.get(name);
    if (x && y && x.mode === y.mode && x.id === y.id) continue;
    const path = prefix + name;
    const xTree = x?.mode === FileMode.TREE;
    const yTree = y?.mode === FileMode.TREE;
    if (xTree || yTree) {
      // a file replaced by a directory (or back): the file goes, the directory recurses
      if (x && !xTree) out.push({ path, old: x });
      await treeChanges(
        trees,
        xTree ? x?.id : undefined,
        yTree ? y?.id : undefined,
        `${path}/`,
        out,
      );
      if (y && !yTree) out.push({ path, new: y });
      continue;
    }
    out.push({ path, ...(x ? { old: x } : {}), ...(y ? { new: y } : {}) });
  }
  return out;
}

/** git's remove_space: every space, tab, CR and LF dropped. */
function removeSpace(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length);
  let n = 0;
  for (const c of bytes) if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) out[n++] = c;
  return out.subarray(0, n);
}

const str = (h: Hasher, s: string) => h.update(encoder.encode(s));
const mode = (h: Hasher, m: number) => str(h, m.toString(8).padStart(6, "0"));

/** What a side of a file pair holds as text (a gitlink: its "Subproject commit" line). */
async function contentOf(blobs: Blobs, side: { mode: number; id: ObjectId }): Promise<Uint8Array> {
  if ((side.mode & S_IFMT) === FileMode.GITLINK) {
    return encoder.encode(`Subproject commit ${side.id}\n`);
  }
  return readBlob(blobs, side.id);
}

const isBinary = (bytes: Uint8Array) => bytes.subarray(0, 8000).includes(0);

/**
 * The patch-id of the change from `parentTree` to `tree` (hex), or undefined when nothing
 * changes. With `headerOnly` (git's `diff_header_only`), only the files' names and modes
 * are hashed, no content read: equal patch-ids have equal header ids, so the cheap id sorts
 * out candidates and the full one is computed only where they collide (patch-ids.c).
 */
export async function patchId(
  trees: PatchIdTrees,
  blobs: Blobs,
  parentTree: ObjectId | undefined,
  tree: ObjectId,
  options: { headerOnly?: boolean; objectFormat?: ObjectFormat } = {},
): Promise<string | undefined> {
  const changes = await treeChanges(trees, parentTree, tree);
  if (changes.length === 0) return undefined;
  return patchIdOfChanges(blobs, changes, options);
}

/** A changed file for {@link patchIdOfChanges}; `oldPath` differs from `path` for a rename. */
export interface PatchIdChange {
  path: string;
  oldPath?: string;
  old?: { mode: number; id: ObjectId };
  new?: { mode: number; id: ObjectId };
}

/**
 * The patch-id of a list of changed files as the diff queue has them (renames and copies
 * found by the caller, as `git format-patch --base` finds them).
 */
export async function patchIdOfChanges(
  blobs: Blobs,
  changes: PatchIdChange[],
  options: { headerOnly?: boolean; objectFormat?: ObjectFormat } = {},
): Promise<string> {
  // the repository's hash (git's the_hash_algo): a SHA-256 repository's patch-ids are 64-hex
  const format = options.objectFormat ?? blobs.objectFormat ?? SHA1_OBJECT_FORMAT;
  const sum = new Uint8Array(format.rawLength);
  for (const change of changes) {
    const h = format.createHasher();
    const newPath = removeSpace(encodeGitPath(change.path));
    const oldPath =
      change.oldPath !== undefined ? removeSpace(encodeGitPath(change.oldPath)) : newPath;
    str(h, "diff--git");
    str(h, "a/");
    h.update(oldPath);
    str(h, "b/");
    h.update(newPath);
    if (!change.old && change.new) {
      str(h, "newfilemode");
      mode(h, change.new.mode);
    } else if (change.old && !change.new) {
      str(h, "deletedfilemode");
      mode(h, change.old.mode);
    } else if (change.old && change.new && change.old.mode !== change.new.mode) {
      str(h, "oldmode");
      mode(h, change.old.mode);
      str(h, "newmode");
      mode(h, change.new.mode);
    }
    const a =
      change.old && !options.headerOnly ? await contentOf(blobs, change.old) : new Uint8Array(0);
    const b =
      change.new && !options.headerOnly ? await contentOf(blobs, change.new) : new Uint8Array(0);
    if (options.headerOnly) {
      // only the header
    } else if (isBinary(a) || isBinary(b)) {
      str(h, change.old?.id ?? format.nullId);
      str(h, change.new?.id ?? format.nullId);
    } else {
      if (!change.old) {
        str(h, "---/dev/null");
        str(h, "+++b/");
        h.update(newPath);
      } else if (!change.new) {
        str(h, "---a/");
        h.update(oldPath);
        str(h, "+++/dev/null");
      } else {
        str(h, "---a/");
        h.update(oldPath);
        str(h, "+++b/");
        h.update(newPath);
      }
      // xdiff's lines without hunk headers (myers, three lines of context)
      const result = unifiedDiffHunks(a, b, { context: 3 });
      for (const hunk of result.hunks) {
        for (const line of hunk.lines) {
          const lines = line.kind === "-" ? result.old : result.new;
          str(h, line.kind === " " ? "" : line.kind);
          h.update(removeSpace(lines.line(line.index)));
        }
      }
    }
    // flush_one_hunk: the file's hash added to the sum, bytewise with carry
    const digest = h.digest();
    let carry = 0;
    for (let i = 0; i < sum.length; i++) {
      carry += sum[i] + digest[i];
      sum[i] = carry & 0xff;
      carry >>= 8;
    }
  }
  return bytesToHex(sum);
}

/** The change a commit makes, as {@link PatchIds} asks for it. */
export interface PatchIdCommit {
  /** Its first parent's tree; undefined for a root commit (diffed against the empty tree) */
  parentTree?: ObjectId;
  tree: ObjectId;
}

/** What {@link PatchIds} reads. */
export interface PatchIdsHost<K> {
  trees: PatchIdTrees;
  blobs: Blobs;
  objectFormat?: ObjectFormat;
  /**
   * The change of a commit, or undefined where git's patch_id_defined says no (a merge: more
   * than one parent, as the walk has them)
   */
  change(key: K): Promise<PatchIdCommit | undefined>;
  /** The paths the diffs are limited to (the walk's pathspec); every path without */
  paths?: (path: string) => boolean;
}

/**
 * patch-ids.c: a table of commits by patch-id. Each commit added gets only the cheap id of
 * its diff's headers (names and modes, no content read); a lookup computes the same cheap
 * id, and the full patch-ids of both sides only where those collide (patch_id_neq), each at
 * most once. A commit whose diff is empty has the null id, as git's, so empty commits match
 * one another.
 *
 * @example
 * ```typescript
 * const ids = new PatchIds({ trees, blobs, change: async (id) => ({ parentTree, tree }) });
 * for (const id of upstream) await ids.add(id);
 * const same = await ids.matches(mine); // the upstream commits making mine's change
 * ```
 */
export class PatchIds<K> {
  private readonly byHeader = new Map<string, K[]>();
  private readonly full = new Map<K, string | null>();
  private readonly nullId: string;

  constructor(private readonly host: PatchIdsHost<K>) {
    const format = host.objectFormat ?? host.blobs.objectFormat ?? SHA1_OBJECT_FORMAT;
    this.nullId = format.nullId;
  }

  /** add_commit_patch_id: false for a commit without a patch-id (a merge). */
  async add(key: K): Promise<boolean> {
    const header = await this.headerId(key);
    if (header === undefined) return false;
    const list = this.byHeader.get(header);
    if (list) list.push(key);
    else this.byHeader.set(header, [key]);
    return true;
  }

  /**
   * patch_id_iter_first/next: the commits added whose patch-id is `key`'s, in the order
   * added (none for a merge).
   */
  async matches(key: K): Promise<K[]> {
    const header = await this.headerId(key);
    const candidates = header === undefined ? undefined : this.byHeader.get(header);
    if (!candidates) return [];
    const mine = await this.fullId(key);
    if (mine === null) return [];
    const found: K[] = [];
    for (const c of candidates) if ((await this.fullId(c)) === mine) found.push(c);
    return found;
  }

  /** has_commit_patch_id */
  async has(key: K): Promise<boolean> {
    return (await this.matches(key)).length > 0;
  }

  /**
   * The full patch-id of a commit (hex; the null id for an empty diff), null when it has
   * none (a merge, or a commit that could not be read: never equal to another, as git errs on
   * the side of keeping both).
   */
  async fullId(key: K): Promise<string | null> {
    let id = this.full.get(key);
    if (id === undefined) {
      // git's "Could not get patch ID": the commit then equals no other
      id = (await this.compute(key, false).catch(() => undefined)) ?? null;
      this.full.set(key, id);
    }
    return id;
  }

  private headerId(key: K): Promise<string | undefined> {
    return this.compute(key, true);
  }

  /** commit_patch_id */
  private async compute(key: K, headerOnly: boolean): Promise<string | undefined> {
    const change = await this.host.change(key);
    if (!change) return undefined;
    const changes = await treeChanges(this.host.trees, change.parentTree, change.tree);
    const paths = this.host.paths;
    const kept = paths ? changes.filter((c) => paths(c.path)) : changes;
    if (kept.length === 0) return this.nullId;
    return patchIdOfChanges(this.host.blobs, kept, {
      headerOnly,
      ...(this.host.objectFormat ? { objectFormat: this.host.objectFormat } : {}),
    });
  }
}

/** How `git patch-id` hashes a patch: `--unstable`, `--stable`, `--verbatim`. */
export interface PatchIdTextOptions {
  /** Each file's hash summed apart, so the files' order does not matter (`--stable`) */
  stable?: boolean;
  /** Whitespace kept (`--verbatim`, which git makes stable too) */
  verbatim?: boolean;
  /** The hash (git's `the_hash_algo`: the repository's, SHA-1 outside one) */
  objectFormat?: ObjectFormat;
}

const isAlpha = (c: number) => (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a);
const isHex = (c: number) =>
  (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);

function startsWith(line: Uint8Array, prefix: string, at = 0): boolean {
  if (line.length - at < prefix.length) return false;
  for (let i = 0; i < prefix.length; i++) if (line[at + i] !== prefix.charCodeAt(i)) return false;
  return true;
}

/** `strspn(digits)` then `atoi` from `at`: [value, digits read]. */
function digitsAt(line: Uint8Array, at: number): [number, number] {
  let n = 0;
  let value = 0;
  while (at + n < line.length && (line[at + n] as number) >= 0x30 && (line[at + n] as number) <= 0x39) {
    value = value * 10 + ((line[at + n] as number) - 0x30);
    n++;
  }
  return [value, n];
}

/**
 * builtin/patch-id.c's `scan_hunk_header` over `@@ -a,b +c,d @@`: the counts it set, which
 * on a malformed header may be the old count alone (git ignores its failure).
 */
function scanHunkHeader(line: Uint8Array): { before: number; after?: number } {
  let q = 4;
  let [, n] = digitsAt(line, q);
  let before = 1;
  if (line[q + n] === 0x2c /* , */) {
    q += n + 1;
    [before, n] = digitsAt(line, q);
  }
  if (n === 0 || line[q + n] !== 0x20 || line[q + n + 1] !== 0x2b /* + */) return { before };
  let r = q + n + 2;
  let after = 1;
  [, n] = digitsAt(line, r);
  if (line[r + n] === 0x2c) {
    r += n + 1;
    [after, n] = digitsAt(line, r);
  }
  return { before, after };
}

/** `remove_space`: the line without git's isspace bytes. */
function withoutSpace(line: Uint8Array): Uint8Array {
  const out = new Uint8Array(line.length);
  let n = 0;
  for (const c of line) if (c !== 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) out[n++] = c;
  return out.subarray(0, n);
}

/**
 * `git patch-id`'s output for a patch (or several, as `git log -p` and `git format-patch`
 * write them): a `<patch-id> <commit>` line for each commit whose diff is not empty, the
 * commit read from its `commit <id>` or `From <id>` line (the null id before the first). The
 * diff text is hashed as builtin/patch-id.c reads it: the commit message and hunk headers
 * skipped, whitespace dropped unless `verbatim`, the `index` line's ids standing for a
 * binary diff, each file's hash summed apart when `stable`.
 *
 * @example
 * ```typescript
 * patchIdsOfPatchText(new TextEncoder().encode(logOutput), { stable: true });
 * // "f0b2a1... 3d4e5f...\n"
 * ```
 */
export function patchIdsOfPatchText(input: Uint8Array, options: PatchIdTextOptions = {}): string {
  const format = options.objectFormat ?? SHA1_OBJECT_FORMAT;
  const verbatim = options.verbatim === true;
  const stable = options.stable === true || verbatim;
  const hexLength = format.rawLength * 2;
  let pos = 0;
  /** strbuf_getwholeline, then the line as C sees it: up to its first NUL */
  const nextLine = (): Uint8Array | undefined => {
    if (pos >= input.length) return undefined;
    const nl = input.indexOf(0x0a, pos);
    const end = nl < 0 ? input.length : nl + 1;
    let line = input.subarray(pos, end);
    pos = end;
    const nul = line.indexOf(0);
    if (nul >= 0) line = line.subarray(0, nul);
    return line;
  };
  const hexAt = (line: Uint8Array, at: number): string | undefined => {
    if (line.length - at < hexLength) return undefined;
    for (let i = 0; i < hexLength; i++) if (!isHex(line[at + i] as number)) return undefined;
    return new TextDecoder().decode(line.subarray(at, at + hexLength)).toLowerCase();
  };
  const addInto = (result: Uint8Array, h: Hasher) => {
    const digest = h.digest();
    let carry = 0;
    for (let i = 0; i < result.length; i++) {
      carry += (result[i] as number) + (digest[i] as number);
      result[i] = carry & 0xff;
      carry >>= 8;
    }
  };

  /** get_one_patchid: [patch length, patch-id, the next commit] */
  const getOne = (): [number, string, string] => {
    let patchlen = 0;
    let next = format.nullId;
    let before = -1;
    let after = -1;
    let binary = false;
    let preId = new Uint8Array(0);
    let postId = new Uint8Array(0);
    let h = format.createHasher();
    const result = new Uint8Array(format.rawLength);
    const flush = () => {
      addInto(result, h);
      h = format.createHasher();
    };
    for (let line = nextLine(); line !== undefined; line = nextLine()) {
      let p = 0;
      if (startsWith(line, "commit ")) p = 7;
      else if (startsWith(line, "From ")) p = 5;
      else if (startsWith(line, "\\ ") && line.length > 12) {
        // "\ No newline at end of file"
        if (verbatim) h.update(line);
        continue;
      }
      const id = hexAt(line, p);
      if (id !== undefined) {
        next = id;
        break;
      }
      // the commit message
      if (!patchlen && !startsWith(line, "diff ")) continue;
      // a diff header
      if (before === -1) {
        if (startsWith(line, "GIT binary patch") || startsWith(line, "Binary files")) {
          binary = true;
          before = 0;
          h.update(preId);
          h.update(postId);
          if (stable) flush();
          continue;
        }
        if (startsWith(line, "index ")) {
          // the ids around `..`, up to a space or the line's last byte (64 at most)
          let dots = -1;
          for (let i = 0; i + 1 < line.length; i++) {
            if (line[i] === 0x2e && line[i + 1] === 0x2e) {
              dots = i;
              break;
            }
          }
          if (dots >= 0) {
            const space = line.indexOf(0x20, dots);
            const end = space >= 0 ? space : line.length - 1;
            preId = line.slice(6, Math.min(dots, 6 + 64));
            postId = line.slice(dots + 2, Math.min(Math.max(end, dots + 2), dots + 2 + 64));
          }
          continue;
        }
        if (startsWith(line, "--- ")) {
          before = 1;
          after = 1;
        } else if (!isAlpha(line[0] ?? 0)) break;
      }
      if (binary) {
        if (startsWith(line, "diff ")) {
          binary = false;
          before = -1;
        }
        continue;
      }
      // looking for a hunk header
      if (before === 0 && after === 0) {
        if (startsWith(line, "@@ -")) {
          const counts = scanHunkHeader(line);
          before = counts.before;
          if (counts.after !== undefined) after = counts.after;
          continue;
        }
        // the end of the patch
        if (!startsWith(line, "diff ")) break;
        // another file's header
        if (stable) flush();
        before = -1;
        after = -1;
      }
      // a line of a hunk
      if (line[0] === 0x2d /* - */ || line[0] === 0x20) before--;
      if (line[0] === 0x2b /* + */ || line[0] === 0x20) after--;
      const hashed = verbatim ? line : withoutSpace(line);
      patchlen += hashed.length;
      h.update(hashed);
    }
    flush();
    return [patchlen, bytesToHex(result), next];
  };

  let out = "";
  let commit = format.nullId;
  while (pos < input.length) {
    const [patchlen, id, next] = getOne();
    if (patchlen) out += `${id} ${commit}\n`;
    commit = next;
  }
  return out;
}
