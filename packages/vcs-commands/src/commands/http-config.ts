/**
 * git's `http.*` configuration for one remote URL (http.c's `http_init`: `http_options`
 * called through `urlmatch_config_entry`), as the HTTP client takes it. `http.<url>.<key>`
 * entries apply where `<url>` matches the remote's URL (git's urlmatch: scheme, user, host
 * with `*` components, port, path prefix), the best match winning; a multi-valued key
 * (`http.extraHeader`) collects every value from entries no worse than the best seen so far,
 * an empty value clearing the list. `GIT_HTTP_USER_AGENT`, `GIT_HTTP_MAX_RETRIES`,
 * `GIT_HTTP_RETRY_AFTER` and `GIT_HTTP_MAX_RETRY_TIME` override the configuration.
 *
 * Read here: `extraHeader`, `userAgent`, `followRedirects`, `emptyAuth`, `maxRetries`,
 * `retryAfter`, `maxRetryTime`. TLS, proxy, cookie, version and speed keys are the host
 * `fetch`'s business and are not read.
 *
 * @example
 * ```ts
 * const settings = httpClientSettingsOf(RemoteConfigStore.from(workingCopy), url, environment);
 * // { extraHeaders: ["X-Magic: abra"], followRedirects: "initial", ... }
 * ```
 *
 * @module
 */

import type { HttpClientSettings } from "@statewalker/vcs-transport";
import { isUrlNormalizeError, normalizeUrl, urlMatchedEntries } from "@statewalker/vcs-utils";
import { parseGitBool, parseGitInt } from "@statewalker/vcs-utils/encoding";
import type { GitHostEnvironment } from "@statewalker/vcs-working-tree";
import { InvalidConfigError } from "../errors/index.js";
import type { RemoteConfigStore } from "../remote-config/index.js";

/** Options of {@link httpClientSettingsOf}. */
export interface HttpConfigOptions {
  /** As git 2.43: no retries on 429 (`http.maxRetries` came with 2.52) */
  compatibility?: "2.43" | "2.56";
}

/**
 * The HTTP client settings git's configuration gives `url` (see the module notes); undefined
 * when the configuration cannot list its variables and the environment sets none.
 *
 * @throws InvalidConfigError for a value git dies on (`http.extraHeader` without a value, a
 *   number that is not one)
 */
export function httpClientSettingsOf(
  config: RemoteConfigStore,
  url: string,
  environment?: Pick<GitHostEnvironment, "httpVariables">,
  options: HttpConfigOptions = {},
): HttpClientSettings {
  const settings: {
    -readonly [K in keyof HttpClientSettings]: HttpClientSettings[K];
  } = {};
  const extraHeaders: string[] = [];
  let sawExtraHeader = false;
  const entries = config.entriesWithPrefix("http.") ?? [];
  const normalized = normalizeUrl(url);
  // http_init normalizes the URL; one git cannot normalize matches only the plain keys
  const matched = isUrlNormalizeError(normalized)
    ? entries
        .filter((e) => e.key.indexOf(".", 5) < 0)
        .map((entry) => ({ name: entry.key.slice(5), entry }))
    : [...urlMatchedEntries(entries, "http", normalized)];
  for (const { name, entry } of matched) {
    const key = `http.${name}`;
    const value = entry.value;
    switch (name) {
      case "extraheader":
        if (value === undefined) throw missingValue(key);
        sawExtraHeader = true;
        if (value === "") extraHeaders.length = 0;
        else extraHeaders.push(value);
        break;
      case "useragent":
        if (value === undefined) throw missingValue(key);
        settings.userAgent = value;
        break;
      case "emptyauth":
        settings.emptyAuth = value === "auto" ? "auto" : bool(key, value);
        break;
      case "followredirects":
        settings.followRedirects =
          value === "initial" ? "initial" : bool(key, value) ? "always" : "none";
        break;
      case "maxretries":
        settings.maxRetries = int(key, value);
        break;
      case "retryafter":
        settings.retryAfter = int(key, value);
        break;
      case "maxretrytime":
        settings.maxRetryTime = int(key, value);
        break;
    }
  }
  if (sawExtraHeader && extraHeaders.length > 0) settings.extraHeaders = extraHeaders;
  const vars = environment?.httpVariables ?? {};
  // set_from_env / set_long_from_env: a variable set wins over the configuration
  if (vars.GIT_HTTP_USER_AGENT !== undefined) settings.userAgent = vars.GIT_HTTP_USER_AGENT;
  const envLong = (name: keyof NonNullable<GitHostEnvironment["httpVariables"]>) => {
    const text = vars[name];
    if (text === undefined) return undefined;
    // strtol: the leading number, 0 without one
    const m = /^\s*[-+]?\d+/.exec(text);
    return m ? Number.parseInt(m[0], 10) : 0;
  };
  const maxRetries = envLong("GIT_HTTP_MAX_RETRIES");
  if (maxRetries !== undefined) settings.maxRetries = maxRetries;
  const retryAfter = envLong("GIT_HTTP_RETRY_AFTER");
  if (retryAfter !== undefined) settings.retryAfter = retryAfter;
  const maxRetryTime = envLong("GIT_HTTP_MAX_RETRY_TIME");
  if (maxRetryTime !== undefined) settings.maxRetryTime = maxRetryTime;
  if (options.compatibility === "2.43") settings.rateLimitRetries = false;
  return settings;
}

function missingValue(key: string): InvalidConfigError {
  return new InvalidConfigError(key, `error: missing value for '${key}'`);
}

/** git_config_bool: a valueless key is true, a bad value dies. */
function bool(key: string, value: string | undefined): boolean {
  if (value === undefined) return true;
  const parsed = parseGitBool(value);
  if (parsed === undefined) {
    throw new InvalidConfigError(key, `fatal: bad boolean config value '${value}' for '${key}'`);
  }
  return parsed;
}

/** git_config_int: a number with an optional k/m/g unit, else git's death. */
function int(key: string, value: string | undefined): number {
  const parsed = value === undefined ? undefined : parseGitInt(value);
  if (parsed === undefined) {
    throw new InvalidConfigError(
      key,
      `fatal: bad numeric config value '${value ?? ""}' for '${key}': invalid unit`,
    );
  }
  return parsed;
}
