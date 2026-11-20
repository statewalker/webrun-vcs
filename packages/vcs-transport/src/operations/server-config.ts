/**
 * The server settings git reads from a served repository's configuration: receive-pack's
 * ref policies (`receive.denyDeletes`, `receive.denyNonFastForwards`,
 * `receive.denyCurrentBranch`, `receive.denyDeleteCurrent`, `receive.shallowUpdate`) and the
 * hidden refs of each service (`transfer.hideRefs` with `uploadpack.hideRefs` or
 * `receive.hideRefs`). The local transport and a smart-HTTP server serving a repository on
 * disk map them alike: spread the result into `serveOverDuplex` options, or (renamed as
 * {@link httpServerSettings} does) into the HTTP server's.
 *
 * @example
 * ```typescript
 * const settings = serverSettingsFromConfig(config); // config: { getAll(key) }
 * await serveOverDuplex({ duplex, repository, refStore, service, ...settings });
 * ```
 */

import type { ReceiveDenyAction } from "../fsm/push/receive-pack-types.js";

/** Reads a repository's configuration. */
export interface ServerConfigReader {
  /**
   * Every value of `key` (`section.name`, case-insensitive), in the order git reads them; a
   * key written without `=` is `true`, `null` or `undefined`.
   */
  getAll(key: string): unknown[];
  /**
   * Every entry in the order git reads them. Optional: with it the hidden ref patterns keep
   * git's order across `transfer.hideRefs` and the service's own key; without it the
   * `transfer.hideRefs` patterns come first.
   */
  list?(): Iterable<{ key: string; value: unknown }>;
}

/** What {@link serverSettingsFromConfig} reads. */
export interface ServerConfigSettings {
  /** Not `receive.denyDeletes` */
  allowDeletes: boolean;
  /** Not `receive.denyNonFastForwards` (git's default: forced updates are accepted) */
  allowNonFastForward: boolean;
  /** `receive.denyCurrentBranch`; `"unconfigured"` when it is not set */
  denyCurrentBranch: ReceiveDenyAction;
  /** `receive.denyDeleteCurrent`; `"unconfigured"` when it is not set */
  denyDeleteCurrent: ReceiveDenyAction;
  /** `receive.shallowUpdate` */
  shallowUpdate: boolean;
  /** upload-pack's hidden ref patterns: `transfer.hideRefs` and `uploadpack.hideRefs` */
  uploadPackHideRefs: string[];
  /** receive-pack's hidden ref patterns: `transfer.hideRefs` and `receive.hideRefs` */
  receivePackHideRefs: string[];
}

/** git's `git_config_bool`: a key without a value is true, an empty value false. */
function configBool(value: unknown, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (value === null || value === true) return true;
  if (value === false) return false;
  const text = String(value).trim().toLowerCase();
  if (["true", "yes", "on"].includes(text)) return true;
  if (["false", "no", "off", ""].includes(text)) return false;
  const n = Number(text);
  return Number.isFinite(n) ? n !== 0 : fallback;
}

/** receive-pack.c's `parse_deny_action`. */
function denyAction(values: unknown[]): ReceiveDenyAction {
  if (values.length === 0) return "unconfigured";
  const value = values[values.length - 1];
  if (typeof value === "string") {
    const lower = value.toLowerCase();
    if (lower === "ignore") return "ignore";
    if (lower === "warn") return "warn";
    if (lower === "refuse") return "refuse";
    if (lower === "updateinstead") return "updateInstead";
  }
  return configBool(value, true) ? "refuse" : "ignore";
}

/** The last value of `key`, or undefined. */
function last(config: ServerConfigReader, key: string): unknown {
  const all = config.getAll(key);
  return all.length === 0 ? undefined : all[all.length - 1];
}

/** git's `parse_hide_refs_config`: the patterns of `section` (and `transfer`), in order. */
function hideRefs(config: ServerConfigReader, section: string): string[] {
  const out: string[] = [];
  const push = (value: unknown) => {
    // a key without a value is an error in git (config_error_nonbool); skipped here
    if (typeof value !== "string") return;
    out.push(value.replace(/\/+$/, ""));
  };
  const keys = new Set(["transfer.hiderefs", `${section}.hiderefs`]);
  if (config.list) {
    for (const { key, value } of config.list()) {
      if (keys.has(key.toLowerCase())) push(value);
    }
    return out;
  }
  for (const value of config.getAll("transfer.hideRefs")) push(value);
  for (const value of config.getAll(`${section}.hideRefs`)) push(value);
  return out;
}

/** git's defaults: what {@link serverSettingsFromConfig} gives for an empty configuration. */
export const GIT_SERVER_SETTINGS_DEFAULTS: Readonly<ServerConfigSettings> = Object.freeze({
  allowDeletes: true,
  allowNonFastForward: true,
  denyCurrentBranch: "unconfigured",
  denyDeleteCurrent: "unconfigured",
  shallowUpdate: false,
  uploadPackHideRefs: [],
  receivePackHideRefs: [],
});

/**
 * The settings the configuration sets explicitly: a key appears only when one of the
 * variables behind it has a value (`receive.denyDeletes` set, a hidden ref pattern listed),
 * so the result can be layered over another source's settings without resetting what the
 * configuration leaves alone to git's defaults (see `serveGitService`).
 *
 * @example
 * ```typescript
 * explicitServerSettingsFromConfig(config); // [receive] denyDeletes = true → { allowDeletes: false }
 * ```
 */
export function explicitServerSettingsFromConfig(
  config: ServerConfigReader,
): Partial<ServerConfigSettings> {
  const out: Partial<ServerConfigSettings> = {};
  const denyDeletes = last(config, "receive.denyDeletes");
  if (denyDeletes !== undefined) out.allowDeletes = !configBool(denyDeletes, false);
  const denyNonFf = last(config, "receive.denyNonFastForwards");
  if (denyNonFf !== undefined) out.allowNonFastForward = !configBool(denyNonFf, false);
  const current = config.getAll("receive.denyCurrentBranch");
  if (current.length > 0) out.denyCurrentBranch = denyAction(current);
  const deleteCurrent = config.getAll("receive.denyDeleteCurrent");
  if (deleteCurrent.length > 0) out.denyDeleteCurrent = denyAction(deleteCurrent);
  const shallow = last(config, "receive.shallowUpdate");
  if (shallow !== undefined) out.shallowUpdate = configBool(shallow, false);
  const upload = hideRefs(config, "uploadpack");
  if (upload.length > 0) out.uploadPackHideRefs = upload;
  const receive = hideRefs(config, "receive");
  if (receive.length > 0) out.receivePackHideRefs = receive;
  return out;
}

/**
 * The served repository's settings, as git's receive-pack and upload-pack read them from
 * its configuration: every key, git's default ({@link GIT_SERVER_SETTINGS_DEFAULTS}) where the
 * configuration sets none ({@link explicitServerSettingsFromConfig} gives only the keys set).
 */
export function serverSettingsFromConfig(config: ServerConfigReader): ServerConfigSettings {
  return {
    ...GIT_SERVER_SETTINGS_DEFAULTS,
    uploadPackHideRefs: [],
    receivePackHideRefs: [],
    ...explicitServerSettingsFromConfig(config),
  };
}

/**
 * {@link serverSettingsFromConfig} as the smart-HTTP server takes it: the receive-pack
 * policies and hidden refs under `receivePack`, upload-pack's hidden refs under `uploadPack`.
 */
export function httpServerSettings(settings: ServerConfigSettings): {
  receivePack: {
    allowDeletes: boolean;
    allowNonFastForward: boolean;
    denyCurrentBranch: ReceiveDenyAction;
    denyDeleteCurrent: ReceiveDenyAction;
    shallowUpdate: boolean;
    hideRefs: string[];
  };
  uploadPack: { hideRefs: string[] };
} {
  return {
    receivePack: {
      allowDeletes: settings.allowDeletes,
      allowNonFastForward: settings.allowNonFastForward,
      denyCurrentBranch: settings.denyCurrentBranch,
      denyDeleteCurrent: settings.denyDeleteCurrent,
      shallowUpdate: settings.shallowUpdate,
      hideRefs: settings.receivePackHideRefs,
    },
    uploadPack: { hideRefs: settings.uploadPackHideRefs },
  };
}
