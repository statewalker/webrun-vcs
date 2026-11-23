/**
 * The base of the commands that list refs through git's ref-filter (`for-each-ref` now, the
 * listings of `branch` and `tag` next): the repository as the filter and the format read it.
 *
 * @module
 */

import {
  countAheadBehind,
  type GitObject,
  type ObjectId,
  RefStorage,
  replacementOf,
  serializeCommit,
  serializeTag,
} from "@statewalker/vcs-core";

import { wildmatch } from "@statewalker/vcs-working-tree";

import { RefFilterError } from "../../errors/index.js";
import { GitCommand } from "../../git-command.js";
import { RemoteConfigStore } from "../../remote-config/index.js";
import { applyRefspecs } from "../branch-tracking.js";
import { createDescriber } from "../git-describe.js";
import { hostEnvironmentOf } from "../git-ident.js";
import { type Mailmap, readRepositoryMailmap } from "../mailmap.js";
import { trailerConfigOf } from "../trailers.js";
import type { ListedRef, RefFilterSource } from "./ref-filter.js";
import type { RefFormatObject, RefFormatSource } from "./ref-format.js";

/** The root refs probed for `--include-root-refs` (git lists every root ref file it finds). */
const ROOT_REFS = [
  "AUTO_MERGE",
  "BISECT_EXPECTED_REV",
  "BISECT_HEAD",
  "CHERRY_PICK_HEAD",
  "MERGE_AUTOSTASH",
  "NOTES_MERGE_PARTIAL",
  "NOTES_MERGE_REF",
  "ORIG_HEAD",
  "REBASE_HEAD",
  "REVERT_HEAD",
];

/**
 * A command listing refs through the ref-filter module: {@link filterSource} and
 * {@link formatSource} read this command's repository (replace refs, the commit-graph, its
 * configuration and worktrees).
 */
export abstract class RefListingCommand<T> extends GitCommand<T> {
  private objectCache = new Map<ObjectId, Promise<RefFormatObject | undefined>>();
  private replacements?: Promise<ReadonlyMap<ObjectId, ObjectId> | undefined>;
  private worktreeHeads?: Promise<Map<string, string>>;

  /** An object's type and content, through replace refs (git's OBJECT_INFO_LOOKUP_REPLACE). */
  protected readObjectForFilter(id: ObjectId): Promise<RefFormatObject | undefined> {
    let known = this.objectCache.get(id);
    if (!known) {
      known = this.loadObject(id);
      this.objectCache.set(id, known);
    }
    return known;
  }

  private async loadObject(id: ObjectId): Promise<RefFormatObject | undefined> {
    this.replacements ??= this.objectReplacements().then((r) =>
      r?.replace.size ? r.replace : undefined,
    );
    const replace = await this.replacements;
    const read = replace ? replacementOf(replace, id) : id;
    const objects = this._workingCopy.history?.objects;
    if (objects) {
      let obj: GitObject | undefined;
      try {
        obj = await objects.get(read);
      } catch {
        return undefined;
      }
      if (!obj) return undefined;
      let bytes = obj.bytes;
      if (!bytes) {
        const chunks: Uint8Array[] = [];
        for await (const c of obj.content) chunks.push(c);
        bytes = join(chunks);
      }
      return { type: obj.type as RefFormatObject["type"], bytes };
    }
    // stores of parsed objects: the objects re-encoded
    const type = await this.revisionResolver()
      .objectType(read)
      .catch(() => undefined);
    switch (type) {
      case "commit": {
        const commit = await this.storedCommits.load(read).catch(() => undefined);
        return commit ? { type, bytes: serializeCommit(commit) } : undefined;
      }
      case "tag": {
        const tag = await this.tagsStore?.load(read).catch(() => undefined);
        return tag
          ? { type, bytes: serializeTag(tag as Parameters<typeof serializeTag>[0]) }
          : undefined;
      }
      case "tree": {
        const raw = await this.storedTrees.raw?.(read);
        return raw ? { type, bytes: raw } : undefined;
      }
      case "blob": {
        const content = await this.storedBlobs.load(read).catch(() => undefined);
        if (!content) return undefined;
        const chunks: Uint8Array[] = [];
        for await (const c of content) chunks.push(c);
        return { type, bytes: join(chunks) };
      }
      default:
        return undefined;
    }
  }

  private config(): RemoteConfigStore {
    return RemoteConfigStore.from(this._workingCopy);
  }

  /** The ref a name finally resolves to through symbolic refs (`refs_resolve_refdup`). */
  private async resolveChain(
    name: string,
  ): Promise<{ name: string; id?: ObjectId; packed: boolean }> {
    const refs = this.refsStore;
    let current = name;
    for (let depth = 0; depth < 5; depth++) {
      const ref = await refs.get(current).catch(() => undefined);
      if (!ref) return { name: current, packed: false };
      if ("target" in ref && typeof ref.target === "string") {
        current = ref.target;
        continue;
      }
      const direct = ref as { objectId?: ObjectId; storage?: RefStorage };
      return {
        name: current,
        ...(direct.objectId ? { id: direct.objectId } : {}),
        packed: direct.storage === RefStorage.PACKED,
      };
    }
    return { name: current, packed: false };
  }

  private async listed(entry: { name: string } & Record<string, unknown>): Promise<ListedRef> {
    if (typeof entry.target === "string") {
      const end = await this.resolveChain(entry.name);
      return {
        name: entry.name,
        symref: entry.target,
        ...(end.id ? { objectId: end.id } : {}),
        packed: end.packed,
      };
    }
    const objectId = entry.objectId as ObjectId | undefined;
    const peeled = entry.peeledObjectId as ObjectId | undefined;
    return {
      name: entry.name,
      ...(objectId ? { objectId } : {}),
      packed: entry.storage === RefStorage.PACKED,
      ...(peeled ? { peeledId: peeled } : {}),
    };
  }

  /**
   * The objects of `--points-at` and the commits of `--contains`, `--no-contains`,
   * `--merged` and `--no-merged`, resolved as parse_options' callbacks do, with their
   * refusals (`error: malformed object name x`, `error: object ... is a tree, not a commit`).
   *
   * @throws RefFilterError where git's option parsing fails (129) or dies (128)
   */
  protected async resolveFilterArgs(args: {
    pointsAt: readonly string[];
    contains: readonly string[];
    noContains: readonly string[];
    merged: readonly string[];
    noMerged: readonly string[];
  }): Promise<{
    pointsAt: ObjectId[];
    contains: ObjectId[];
    noContains: ObjectId[];
    merged: ObjectId[];
    noMerged: ObjectId[];
  }> {
    const resolver = this.revisionResolver();
    const usage = (message: string) => new RefFilterError(message, 129);
    const objectOf = async (name: string) =>
      resolver.resolve(name, { quiet: true }).catch(() => undefined);
    const pointsAt: ObjectId[] = [];
    for (const name of args.pointsAt) {
      const id = await objectOf(name);
      if (!id) throw usage(`error: malformed object name '${name}'`);
      pointsAt.push(id);
    }
    const commitsOf = async (names: readonly string[], merge: string | undefined) => {
      const out: ObjectId[] = [];
      for (const name of names) {
        const id = await objectOf(name);
        if (!id) {
          if (merge) throw new RefFilterError(`fatal: malformed object name ${name}`, 128);
          throw usage(`error: malformed object name ${name}`);
        }
        const commit = await resolver.commitReference(id).catch(() => undefined);
        if (!commit) {
          const type = (await resolver.objectType(id).catch(() => undefined)) ?? "unknown";
          const notCommit = `error: object ${id} is a ${type}, not a commit`;
          throw usage(
            merge
              ? `${notCommit}\nerror: option \`${merge}' must point to a commit`
              : `${notCommit}\nerror: no such commit ${name}`,
          );
        }
        out.push(commit);
      }
      return out;
    };
    return {
      pointsAt,
      contains: await commitsOf(args.contains, undefined),
      noContains: await commitsOf(args.noContains, undefined),
      merged: await commitsOf(args.merged, "merged"),
      noMerged: await commitsOf(args.noMerged, "no-merged"),
    };
  }

  /** The repository as git's ref filter reads it. */
  protected filterSource(): RefFilterSource {
    const refs = this.refsStore;
    const commits = this.walkCommits;
    return {
      listRefs: async () => {
        const out: ListedRef[] = [];
        for await (const entry of refs.list("refs/")) {
          out.push(
            await this.listed(entry as unknown as { name: string } & Record<string, unknown>),
          );
        }
        return out;
      },
      listRootRefs: async () => {
        const out: ListedRef[] = [];
        for (const name of ["HEAD", ...ROOT_REFS]) {
          const entry = await refs.get(name).catch(() => undefined);
          if (!entry) continue;
          const listed = await this.listed(
            entry as unknown as { name: string } & Record<string, unknown>,
          );
          // a dangling symbolic root ref is not listed
          if (listed.objectId) out.push(listed);
        }
        return out;
      },
      head: async () => {
        const entry = await refs.get("HEAD").catch(() => undefined);
        if (!entry) return undefined;
        const listed = await this.listed(
          entry as unknown as { name: string } & Record<string, unknown>,
        );
        // refs_head_ref: only a HEAD that resolves
        return listed.objectId ? listed : undefined;
      },
      readObject: (id) => this.readObjectForFilter(id),
      isAncestor: (ancestor, descendant) => commits.isAncestor(ancestor, descendant),
      commitHeader: async (id) => {
        const c = await commits.load(id).catch(() => undefined);
        return c ? { parents: c.parents, date: c.committer.timestamp } : undefined;
      },
      aheadBehind: (ours, theirs) => this.countAheadBehind(ours, theirs),
      commitByName: async (name, warnings, quiet) => {
        const resolver = this.revisionResolver();
        const id = await resolver
          .resolve(name, quiet ? { quiet: true } : {})
          .catch(() => undefined);
        const commit = id ? await resolver.commitReference(id).catch(() => undefined) : undefined;
        if (!quiet) warnings?.push(...resolver.warnings);
        return commit;
      },
      configValues: (key) => this.config().values(key),
    };
  }

  private countAheadBehind(ours: ObjectId, theirs: ObjectId) {
    const commits = this.walkCommits;
    if (commits.countAheadBehind) return commits.countAheadBehind(ours, theirs);
    return countAheadBehind(
      async (id) => {
        const c = await commits.load(id).catch(() => undefined);
        return c
          ? {
              parents: c.parents,
              date: c.committer.timestamp,
              generation: Number.POSITIVE_INFINITY,
            }
          : undefined;
      },
      ours,
      theirs,
    );
  }

  /** The repository as git's ref format reads it. */
  protected formatSource(): RefFormatSource {
    const refs = this.refsStore;
    const resolver = this.revisionResolver();
    const config = this.config();
    let mailmap: Promise<Mailmap> | undefined;
    let describer: ReturnType<typeof createDescriber> | undefined;
    return {
      readObject: (id) => this.readObjectForFilter(id),
      abbreviate: async (id, minLength) => {
        if (minLength === undefined) return this.abbreviateObjectId(id);
        const lengths = await this.idAbbreviator().lengths([id], minLength);
        return id.slice(0, lengths.get(id) ?? minLength);
      },
      refExists: (name) => refs.has(name).catch(() => false),
      config: (key) => config.value(key),
      headRef: async () => {
        const end = await this.resolveChain("HEAD");
        return end.id ? end.name : undefined;
      },
      upstreamOf: (branch) => resolver.upstreamOf(branch).catch(() => undefined),
      pushOf: (branch) => resolver.pushOf(branch).catch(() => undefined),
      remoteName: (branch, push) => {
        const choice = push
          ? config.pushRemoteChoiceForBranch(branch)
          : config.remoteChoiceForBranch(branch);
        return choice.explicit ? choice.name : "";
      },
      remoteRef: (branch, push) => {
        if (!push) {
          if (config.value(`branch.${branch}.remote`) === undefined) return undefined;
          return config.values(`branch.${branch}.merge`)[0];
        }
        const remote = config.pushRemoteForBranch(branch);
        const specs = config.pushRefspecs(remote);
        return specs.length ? applyRefspecs(specs, `refs/heads/${branch}`) : undefined;
      },
      refCommit: async (ref) => {
        const id = (await refs.resolve(ref).catch(() => undefined))?.objectId;
        return id ? resolver.commitReference(id).catch(() => undefined) : undefined;
      },
      aheadBehind: (ours, theirs) => this.countAheadBehind(ours, theirs),
      worktreePath: async (ref) => {
        this.worktreeHeads ??= this.loadWorktreeHeads();
        return (await this.worktreeHeads).get(ref);
      },
      mailmap: () => {
        mailmap ??= readRepositoryMailmap({
          config: (key) => config.value(key),
          worktree: this.worktreeAccess,
          environment: hostEnvironmentOf(this._workingCopy),
          readBlobNamed: async (name) => {
            const id = await resolver.resolve(name).catch(() => undefined);
            const object = id ? await this.readObjectForFilter(id) : undefined;
            return object?.type === "blob" ? object.bytes : undefined;
          },
        });
        return mailmap;
      },
      describe: (id, options) => {
        describer ??= this.describer();
        return describer(id, {
          ...(options.tags !== undefined ? { tags: options.tags } : {}),
          ...(options.abbrev !== undefined ? { abbrev: options.abbrev } : {}),
          ...(options.match.length ? { match: options.match } : {}),
          ...(options.exclude.length ? { exclude: options.exclude } : {}),
        });
      },
      trailerConfig: () => trailerConfigOf(this._workingCopy),
    };
  }

  /** `git describe` over this repository's tags (`%(describe)`). */
  private describer(): ReturnType<typeof createDescriber> {
    const tags = this.tagsStore;
    return createDescriber({
      refs: this.refsStore,
      ...(tags ? { tags } : {}),
      commits: this.commits,
      wildmatch: (pattern, text) => wildmatch(pattern, text),
      abbreviate: async (id, length) => {
        if (length === 0) return id;
        if (length === undefined) return this.abbreviateObjectId(id);
        const lengths = await this.idAbbreviator().lengths([id], length);
        return id.slice(0, lengths.get(id) ?? length);
      },
    });
  }

  private async loadWorktreeHeads(): Promise<Map<string, string>> {
    const heads = new Map<string, string>();
    const worktrees = this._workingCopy.worktrees;
    if (!worktrees) return heads;
    try {
      for (const wt of await worktrees.list()) {
        if (wt.headRef && !heads.has(wt.headRef)) heads.set(wt.headRef, wt.path);
      }
    } catch {
      // no worktrees to show
    }
    return heads;
  }
}

function join(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0] as Uint8Array;
  let size = 0;
  for (const c of chunks) size += c.length;
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
