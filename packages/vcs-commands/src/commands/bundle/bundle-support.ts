/**
 * What the bundle commands share: bundle.c's `verify_bundle` and `unbundle` over the
 * command's repository.
 */

import { historyWithoutLazyFetch, type ObjectId } from "@statewalker/vcs-core";
import { createRepositoryFacade } from "@statewalker/vcs-transport";

import { GitCommand } from "../../git-command.js";
import type { BundleHeader } from "./bundle-format.js";
import { type OpenedBundle, type VerifyBundleOptions, verifyBundleIn } from "./bundle-verify.js";

/** The commands reading a bundle against the repository. */
export abstract class BundleCommandBase<T> extends GitCommand<T> {
  /**
   * bundle.c's `verify_bundle` against this repository (see {@link verifyBundleIn}).
   */
  protected async verifyBundle(
    header: BundleHeader,
    options: VerifyBundleOptions = {},
  ): Promise<{ ok: boolean; stdout: string; stderr: string }> {
    return verifyBundleIn(
      {
        history: this._workingCopy.history,
        refValues: () => this.allRefValues(),
        shallow: () => this.shallowCommits(),
      },
      header,
      options,
    );
  }

  /**
   * bundle.c's `unbundle`: the bundle verified (git's lines on failure), then its pack
   * indexed and kept (`index-pack --fix-thin --stdin`), a filtered bundle's marked as a
   * promisor pack (`--promisor=from-bundle`).
   */
  protected async unbundleInto(
    bundle: OpenedBundle,
    options: VerifyBundleOptions = {},
  ): Promise<{ ok: boolean; stderr: string; packId?: string }> {
    const verified = await this.verifyBundle(bundle.header, options);
    if (!verified.ok) return { ok: false, stderr: verified.stderr };
    const history = historyWithoutLazyFetch(this._workingCopy.history);
    const facade = createRepositoryFacade({ history });
    const pack = bundle.pack;
    let imported: { packId?: string };
    try {
      imported = await facade.importPack(
        (async function* () {
          yield pack;
        })(),
        { keepPack: true },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const fatal = message.startsWith("fatal: ") ? message : `fatal: ${message}`;
      return { ok: false, stderr: `${fatal}\nerror: index-pack died\n` };
    }
    if (bundle.header.filter !== undefined && imported.packId !== undefined) {
      await facade.markPromisorPack?.(imported.packId, "from-bundle\n");
    }
    return {
      ok: true,
      stderr: "",
      ...(imported.packId !== undefined ? { packId: imported.packId } : {}),
    };
  }

  /** What `rev-list --all` starts from: every ref's value and HEAD's. */
  protected async allRefValues(): Promise<ObjectId[]> {
    const out = new Set<ObjectId>();
    const refs = this.refsStore;
    for await (const ref of refs.list()) {
      const id =
        "objectId" in ref && ref.objectId
          ? ref.objectId
          : (await refs.resolve(ref.name).catch(() => undefined))?.objectId;
      if (id) out.add(id);
    }
    const head = (await refs.resolve("HEAD").catch(() => undefined))?.objectId;
    if (head) out.add(head);
    return [...out];
  }
}
