/**
 * `git unpack-objects` (builtin/unpack-objects.c): a pack read from stdin is exploded into
 * loose objects, as receive-pack and fetch-pack do with a pack under their unpack limit.
 *
 * @example
 * ```typescript
 * // git unpack-objects --strict < pack
 * const { exitCode, stderr } = await git.unpackObjects().setInput(packBytes).setStrict(true).call();
 * ```
 */

import {
  createGitObjects,
  type GitObjects,
  importPack,
  MemoryRawStorage,
  overlayObjects,
  rawStorageStaging,
  unpackObjects,
} from "@statewalker/vcs-core";
import {
  checkUnpackedObjects,
  FetchCheckError,
  parseConfigInt,
  ReceivedObjects,
  repositoryQuarantine,
} from "@statewalker/vcs-transport";
import { receiveFsckOf } from "./fsck/fetch-fsck.js";
import { parseFsckMsgId } from "./fsck/fsck-msg-ids.js";
import { hostEnvironmentOf } from "./git-ident.js";
import { configValue } from "./merge-config.js";
import { PlumbingCommand, PlumbingError } from "./plumbing-command.js";

/** What git's `--strict=<list>` sets, in order (fsck_set_msg_types). */
type StrictItem = { skipList: string } | { msgId: string; value: string };

/**
 * `git unpack-objects [-n] [-q] [--strict[=<msg-id>=<severity>...]]`: reads a pack
 * ({@link setInput}) and writes each of its objects the repository does not have as a loose
 * object, deltas resolved (REF_DELTA bases from the repository too: a thin pack), objects over
 * `core.bigFileThreshold` streamed. Nothing goes to stdout; a bad pack is git's death (exit
 * 128, `fatal: early EOF` for one cut short), the objects written before it are kept.
 *
 * With {@link setStrict} each received commit, tree and tag is checked as git's `--strict`
 * checks it (fsck's strict severities, `--strict=<list>` changing them, `skiplist=<file>`), in
 * pack order and depth first, before it is written: a missing link dies `object of unexpected
 * type`, a failing check `fsck error in packed object`, warnings are printed and the objects
 * written. As in git, a refused pack leaves its blobs (written as they come) and the commits,
 * trees and tags checked before the one refused (written once checked), nothing else.
 * {@link setDryRun} (`-n`) reads and resolves the whole pack and writes nothing, checking
 * nothing either (git skips `--strict` there).
 */
export class UnpackObjectsCommand extends PlumbingCommand {
  private input: AsyncIterable<Uint8Array> = (async function* () {})();
  private dryRun = false;
  private strict: string | undefined;

  /** The pack (git reads it from stdin): its bytes, or a stream of them. */
  setInput(pack: Uint8Array | AsyncIterable<Uint8Array>): this {
    this.checkCallable();
    this.input =
      pack instanceof Uint8Array
        ? (async function* () {
            yield pack;
          })()
        : pack;
    return this;
  }

  /** `-n`: read and verify the pack, writing nothing. */
  setDryRun(dryRun: boolean): this {
    this.checkCallable();
    this.dryRun = dryRun;
    return this;
  }

  /** `-q`: no progress (which this command never prints); accepted for git's command line. */
  setQuiet(_quiet: boolean): this {
    this.checkCallable();
    return this;
  }

  /**
   * `--strict` (true), `--strict=<list>` (a string: `<msg-id>=<severity>` items and
   * `skiplist=<file>`, separated by commas or spaces), or off (false, the default).
   */
  setStrict(strict: boolean | string): this {
    this.checkCallable();
    this.strict = strict === false ? undefined : strict === true ? "" : strict;
    return this;
  }

  protected async run(): Promise<number> {
    const objects = this._workingCopy.history?.objects;
    if (!objects) throw new Error("unpack-objects needs the object store (history.objects)");
    const threshold = parseConfigInt(configValue(this.workingCopy, "core.bigFileThreshold"));
    const options =
      threshold !== undefined && threshold > 0 ? { bigObjectThreshold: threshold } : {};
    try {
      if (this.dryRun) {
        // written to memory over the repository's objects, then dropped
        await unpackObjects(dryRunTarget(objects), this.input, options);
        return 0;
      }
      if (this.strict === undefined) {
        await unpackObjects(objects, this.input, options);
        return 0;
      }
      await this.unpackStrict(objects, this.strict, options);
      return 0;
    } catch (error) {
      if (error instanceof PlumbingError || !(error instanceof Error)) throw error;
      if (error.name === "PackError" || error.name === "ObjectCollisionError") {
        // a pack cut short: git's fill() dies `early EOF`
        const text = /^pack truncated/.test(error.message) ? "early EOF" : error.message;
        throw new PlumbingError(`fatal: ${text}`);
      }
      throw error;
    }
  }

  /** `--strict`: imported aside, checked, then published (what git wrote, when refused). */
  private async unpackStrict(
    objects: GitObjects,
    list: string,
    options: { bigObjectThreshold?: number },
  ): Promise<void> {
    const items = parseStrictList(list);
    const environment = hostEnvironmentOf(this.workingCopy);
    const baseDir = await this.hostWorkingDir();
    const settings = receiveFsckOf({
      entries: () => [
        { key: "receive.fsckobjects", value: "true" },
        ...items.map((item) =>
          "skipList" in item
            ? { key: "receive.fsck.skiplist", value: item.skipList }
            : { key: `receive.fsck.${item.msgId}`, value: item.value },
        ),
      ],
      compatibility: this.hooks.compatibility,
      ...(baseDir !== undefined ? { baseDir } : {}),
      ...(environment
        ? { readFile: (path: string) => environment.readFile(path), home: environment.home }
        : {}),
    });
    if (settings.configError !== undefined) throw new PlumbingError(settings.configError);
    const fsck = await settings.fsckObjects?.();
    if (!fsck) throw new Error("unpack-objects: --strict made no fsck");
    const received = new ReceivedObjects(this.objectFormat.rawLength);
    const imported = await importPack(objects, this.input, {
      ...options,
      quarantine: true,
      onObject: (id, type, entry) => received.add(id, type, entry),
    });
    const quarantine = imported.quarantine;
    const history = this._workingCopy.history;
    if (!quarantine || !history) return; // a store that cannot keep objects aside: written
    let lines: string[];
    // what git has written when a check dies: every blob, and the objects checked before
    const written = new Set<string>();
    for (const { id, type } of received.inPackOrder()) if (type === "blob") written.add(id);
    try {
      const view = repositoryQuarantine(quarantine, history).repository;
      const shallow = new Set((await this.refsStore.getShallow?.().catch(() => [])) ?? []);
      lines = await checkUnpackedObjects(view, received, {
        fsck,
        shallow,
        onWritten: (id) => written.add(id),
      });
    } catch (error) {
      if (!(error instanceof FetchCheckError)) {
        await quarantine.discard().catch(() => {});
        throw error;
      }
      // git writes each blob as it comes and the rest once checked: those stay
      for (const id of written) {
        if (await objects.has(id)) continue;
        await objects.putRaw(id, quarantine.objects.getRaw(id));
      }
      await quarantine.discard().catch(() => {});
      throw new PlumbingError(error.lines.join("\n"), error.exitCode);
    }
    await quarantine.commit();
    for (const line of lines) this.warn(line);
  }
}

/**
 * git's fsck_set_msg_types over `--strict=<list>`: items split at spaces, commas and `|`, each
 * `<msg-id>=<severity>` (or `:`) or `skiplist=<file>`; an item without `=` and an unknown
 * message id die as git does.
 */
function parseStrictList(list: string): StrictItem[] {
  const items: StrictItem[] = [];
  for (const item of list.split(/[ ,|]/)) {
    if (item === "") continue;
    const equal = item.search(/[=:]/);
    const name = (equal < 0 ? item : item.slice(0, equal)).toLowerCase();
    if (name === "skiplist") {
      if (equal < 0) throw new PlumbingError("fatal: skiplist requires a path");
      items.push({ skipList: item.slice(equal + 1) });
      continue;
    }
    if (equal < 0) throw new PlumbingError(`fatal: Missing '=': '${name}'`);
    if (!parseFsckMsgId(name)) throw new PlumbingError(`fatal: Unhandled message id: ${name}`);
    items.push({ msgId: name, value: item.slice(equal + 1) });
  }
  return items;
}

/**
 * Objects written to memory over `objects`: a dry run reads the repository's objects (a thin
 * pack's bases, objects it already has) and writes nothing to it.
 */
function dryRunTarget(objects: GitObjects): GitObjects {
  const top = createGitObjects(rawStorageStaging(new MemoryRawStorage()), {
    ...(objects.objectFormat ? { objectFormat: objects.objectFormat } : {}),
  });
  // the repository's objects, read only: an object it has is not written again
  const base = new Proxy(objects, {
    get(target, property) {
      if (property === "putRaw") return async () => {};
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return overlayObjects(top, base);
}
