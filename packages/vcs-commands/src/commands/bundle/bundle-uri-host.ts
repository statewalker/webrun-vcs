/**
 * The repository side of bundle URIs for clone and fetch: downloads (`copy_uri_to_file`),
 * `unbundle_from_file` (the bundle verified quietly, its pack indexed and kept, its refs
 * written under `refs/bundles/`) and `fetch.bundleCreationToken`.
 */

import {
  historyWithoutLazyFetch,
  type ObjectId,
  objectFormatOf,
  type RefLogOptions,
} from "@statewalker/vcs-core";
import {
  type Credentials,
  checkReceivedPack,
  createRepositoryFacade,
  FetchCheckError,
  type HttpClientSettings,
  type HttpCredentialHelper,
  ReceivedObjects,
  type ReceivedObjectsFsck,
  SmartHttpClient,
} from "@statewalker/vcs-transport";
import type { ObjectFormat } from "@statewalker/vcs-utils/hash";

import type { WorkingCopy } from "../../types.js";
import type { BundleUriHost } from "./bundle-uri.js";
import { openBundle, verifyBundleIn } from "./bundle-verify.js";

/** What {@link createBundleUriHost} works with. */
export interface BundleUriHostOptions {
  workingCopy: WorkingCopy;
  /** Writes a ref (no old value checked: git reads it right before) */
  setRef(name: string, id: ObjectId, log: RefLogOptions): Promise<void>;
  /** Reads a ref's value */
  getRef(name: string): Promise<ObjectId | undefined>;
  /** The reflog entry of a write (`fetched bundle`) */
  reflogLine(message: string): RefLogOptions;
  /**
   * git 2.43 maps only `refs/heads/<name>` to `refs/bundles/<name>`; 2.5x maps every
   * `refs/<name>` to `refs/bundles/<name>` (tags too)
   */
  compatibility?: "2.43" | "2.56";
  /** A local path's bytes (relative paths as the clone resolves its source) */
  readLocalFile(path: string): Promise<Uint8Array | undefined>;
  /** HTTP: the remote's URL; static credentials and headers go only to its origin */
  remoteUrl?: string;
  credentials?: Credentials;
  headers?: Record<string, string>;
  credentialHelper?: HttpCredentialHelper;
  httpSettings?(url: string): HttpClientSettings;
  fetchImpl?: (request: Request) => Promise<Response>;
  /** Reads `fetch.bundleCreationToken` */
  configValue(key: string): string | null | undefined;
  /** Stores `fetch.bundleCreationToken` */
  setConfigValue(key: string, value: string): Promise<void>;
  message(line: string): void;
  /** How the downloaded list file is named in errors */
  tempFileName?(): string;
  /**
   * The hash a bundle header without `@object-format=` is read in (git's `the_hash_algo`):
   * default the repository's
   */
  objectFormat?: ObjectFormat;
  /**
   * git 2.46+'s `VERIFY_BUNDLE_FSCK` (`fetch.fsckObjects`, else `transfer.fsckObjects`): the
   * fsck index-pack's `--fsck-objects` runs over the bundle's objects, or undefined for none
   */
  fsckObjects?(): Promise<ReceivedObjectsFsck | undefined>;
}

/** The origin of a URL, or undefined for one `new URL` cannot read. */
function originOf(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

/** A host over a repository (see {@link BundleUriHostOptions}). */
export function createBundleUriHost(options: BundleUriHostOptions): BundleUriHost {
  const history = options.workingCopy.history;
  const objectFormat = options.objectFormat ?? objectFormatOf(history);
  return {
    async download(uri) {
      if (/^https?:/.test(uri)) return downloadHttp(options, uri);
      // copy_uri_to_file: `file://` dropped, anything else copied as a path
      const path = uri.startsWith("file://") ? uri.slice("file://".length) : uri;
      return options.readLocalFile(path).catch(() => undefined);
    },
    async unbundle(bytes) {
      const opened = openBundle(bytes, "<bundle>", objectFormat);
      if (!opened.ok) return false;
      const { header, pack } = opened.bundle;
      const objects = historyWithoutLazyFetch(history);
      const verified = await verifyBundleIn(
        {
          history,
          refValues: () => refValuesOf(history.refs),
          shallow: async () => (await history.refs.getShallow?.().catch(() => undefined)) ?? [],
        },
        header,
        { quiet: true },
      );
      for (const line of verified.stderr.split("\n")) if (line) options.message(line);
      if (!verified.ok) return false;
      const facade = createRepositoryFacade({ history: objects });
      const fsck = await options.fsckObjects?.();
      let packId: string | undefined;
      try {
        if (fsck) {
          // index-pack --fsck-objects: the objects checked in a quarantine (no links: a bundle
          // has prerequisites), which a refusal discards
          const received = new ReceivedObjects(objectFormat.rawLength);
          const { quarantine, ...imported } = await facade.importPack(
            (async function* () {
              yield pack;
            })(),
            {
              keepPack: true,
              quarantine: true,
              onObject: (id, type, entry) => received.add(id, type, entry),
            },
          );
          let committed = false;
          try {
            const checked = await checkReceivedPack(quarantine?.repository ?? facade, received, {
              fsck,
              links: false,
              shallow: new Set<string>(),
              kept: true,
              tail: null,
            });
            // index-pack's fsck warnings (stderr; VERIFY_BUNDLE_QUIET quiets verify_bundle only)
            for (const line of checked.messages) options.message(line);
            await quarantine?.commit();
            committed = true;
          } finally {
            if (!committed) await quarantine?.discard().catch(() => {});
          }
          packId = imported.packId;
        } else {
          const imported = await facade.importPack(
            (async function* () {
              yield pack;
            })(),
            { keepPack: true },
          );
          packId = imported.packId;
        }
      } catch (error) {
        if (error instanceof FetchCheckError) {
          for (const line of error.lines) options.message(line);
        } else {
          const message = error instanceof Error ? error.message : String(error);
          options.message(message.startsWith("fatal: ") ? message : `fatal: ${message}`);
        }
        options.message("error: index-pack died");
        return false;
      }
      if (header.filter !== undefined && packId !== undefined) {
        await facade.markPromisorPack?.(packId, "from-bundle\n");
      }
      for (const ref of header.references) {
        if (!ref.name.startsWith("refs/")) continue;
        let target: string;
        if (options.compatibility === "2.43") {
          if (!ref.name.startsWith("refs/heads/")) continue;
          target = `refs/bundles/${ref.name.slice("refs/heads/".length)}`;
        } else {
          target = `refs/bundles/${ref.name.slice("refs/".length)}`;
        }
        // refs_update_ref with UPDATE_REFS_MSG_ON_ERR: a failure is reported, not fatal
        if (!(await objectExists(objects, ref.id))) {
          options.message(
            `error: trying to write ref '${target}' with nonexistent object ${ref.id}`,
          );
          continue;
        }
        try {
          await options.setRef(target, ref.id, options.reflogLine("fetched bundle"));
        } catch (error) {
          options.message(`error: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      return true;
    },
    creationToken: () => options.configValue("fetch.bundleCreationToken"),
    setCreationToken: (value) => options.setConfigValue("fetch.bundleCreationToken", value),
    message: (line) => options.message(line),
    objectFormat,
    ...(options.tempFileName ? { tempFileName: options.tempFileName } : {}),
  };
}

/**
 * `download_https_uri_to_file` (git-remote-https's `get`): a URI holding a space or a newline
 * is refused (the remote helper's protocol separates on them); a response that is not 2xx
 * fails. The command's static credentials and headers go only to the remote's own origin
 * (the list is the server's content and may name any host); the credential helper is asked
 * per URL, as git's helper is.
 */
async function downloadHttp(
  options: BundleUriHostOptions,
  uri: string,
): Promise<Uint8Array | undefined> {
  if (/[ \n]/.test(uri)) {
    options.message(`error: bundle-uri: URI is malformed: '${uri}'`);
    return undefined;
  }
  const sameOrigin =
    options.remoteUrl !== undefined &&
    originOf(uri) !== undefined &&
    originOf(uri) === originOf(options.remoteUrl);
  const controller = new AbortController();
  const client = new SmartHttpClient({
    url: uri,
    fetchImpl: options.fetchImpl ?? ((request) => fetch(request)),
    signal: controller.signal,
    ...(sameOrigin && options.headers ? { headers: options.headers } : {}),
    ...(sameOrigin && options.credentials ? { auth: options.credentials } : {}),
    ...(options.httpSettings ? { settings: options.httpSettings(uri) } : {}),
    ...(options.credentialHelper ? { credentialHelper: options.credentialHelper } : {}),
  });
  try {
    const response = await client.get(uri, (next) => next());
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return undefined;
    }
    return new Uint8Array(await response.arrayBuffer());
  } catch {
    return undefined;
  }
}

/** Every ref's value and HEAD's (what `rev-list --all` starts from). */
async function refValuesOf(refs: WorkingCopy["history"]["refs"]): Promise<string[]> {
  const out = new Set<string>();
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

/** git's `parse_object`-free existence check of an object. */
async function objectExists(
  history: ReturnType<typeof historyWithoutLazyFetch>,
  id: ObjectId,
): Promise<boolean> {
  const objects = (history as { objects?: { has(id: ObjectId): Promise<boolean> } }).objects;
  if (objects) return objects.has(id).catch(() => false);
  for (const store of [history.commits, history.trees, history.blobs, history.tags]) {
    if (await store.has(id).catch(() => false)) return true;
  }
  return false;
}
