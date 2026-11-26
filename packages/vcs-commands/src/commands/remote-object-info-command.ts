/**
 * The size and type of objects a remote holds, asked without fetching them: protocol v2's
 * `object-info` (git 2.56's `transport_fetch_object_info`, which `git cat-file
 * --batch-command`'s `remote-object-info` runs).
 *
 * @example
 * ```typescript
 * const info = await git.remoteObjectInfo()
 *   .setRemote("origin")
 *   .addObjectId(blobId)
 *   .call();
 * info.objects[0]; // { id: blobId, missing: false, size: 11, type: "blob" }
 * ```
 */

import {
  fetchObjectInfo,
  type ObjectInfoAnswer,
  type ObjectInfoEntry,
} from "@statewalker/vcs-transport";

import { RemoteConfigStore } from "../remote-config/index.js";
import { TransportCommand } from "../transport-command.js";
import { withRemoteUploadPack } from "./remote-transport.js";

/** What {@link RemoteObjectInfoCommand} answers. */
export interface RemoteObjectInfoResult extends ObjectInfoAnswer {
  /** The URL asked (the remote's, or the one given, `insteadOf` applied) */
  uri: string;
}

export type { ObjectInfoEntry as RemoteObjectInfoEntry };

/**
 * A remote that has no upload-pack to ask (a bundle): git's `transport_get` gives it no
 * `smart_options`, and cat-file dies `failed to get object info from the remote: <remote>`.
 */
export class RemoteObjectInfoUnsupportedError extends Error {
  constructor(readonly remote: string) {
    super(`failed to get object info from the remote: ${remote}`);
    this.name = "RemoteObjectInfoUnsupportedError";
  }
}

/**
 * `object-info` against a remote (a configured name or a URL, as git's `remote_get`):
 * sizes and types are asked only when wanted and advertised by the server, the ids always,
 * so an object the server lacks is reported `missing` either way.
 *
 * @throws ObjectInfoError (vcs-transport) where git dies: `object-info requires protocol v2`,
 *   `object-info capability is not enabled on the server`, a malformed answer
 * @throws RemoteObjectInfoUnsupportedError for a bundle remote
 */
export class RemoteObjectInfoCommand extends TransportCommand<RemoteObjectInfoResult> {
  private remote?: string;
  private readonly ids: string[] = [];
  private wantSize = true;
  private wantType = true;

  /** The remote: a configured remote's name, or a URL or path. */
  setRemote(remote: string): this {
    this.checkCallable();
    this.remote = remote;
    return this;
  }

  /** Adds an object to ask about (a full hex id of the repository's format). */
  addObjectId(id: string): this {
    this.checkCallable();
    this.ids.push(id);
    return this;
  }

  /** Whether sizes are wanted (default true; cat-file: its format has `%(objectsize)`). */
  setSize(size: boolean): this {
    this.checkCallable();
    this.wantSize = size;
    return this;
  }

  /** Whether types are wanted (default true; cat-file: its format has `%(objecttype)`). */
  setType(type: boolean): this {
    this.checkCallable();
    this.wantType = type;
    return this;
  }

  async call(): Promise<RemoteObjectInfoResult> {
    this.checkCallable();
    this.setCallable(false);
    const remote = this.remote;
    if (remote === undefined) throw new Error("No remote given");
    if (this.ids.length === 0) throw new Error("remote-object-info requires objects");
    // remote_get: a legacy remote file first (git 2.x), then the configured URL or the URL given
    await this.loadLegacyRemote(remote);
    const uri = RemoteConfigStore.from(this.workingCopy).remoteUrlOf(remote);
    const prepared = await this.prepareRemote(uri);
    if (prepared.kind === "bundle") throw new RemoteObjectInfoUnsupportedError(remote);
    const answer = await withRemoteUploadPack(prepared, this.remoteSessionOptions(), (c) =>
      fetchObjectInfo(c, {
        ids: this.ids,
        size: this.wantSize,
        type: this.wantType,
        objectFormat: this.objectFormat,
      }),
    );
    return { uri, ...answer };
  }
}
