/**
 * The author and committer of the commits (and the tagger of the tags) our commands write,
 * resolved as git's `ident.c` resolves them, so that the same commands run with the same
 * environment give the same object ids as native git.
 *
 * @example
 * ```typescript
 * const env = { readFile: async () => undefined, committer: { date: "1700000000 +0100" } };
 * const config = { value: (key: string) => ({ "user.name": "Ada", "user.email": "ada@example.com" })[key] };
 * resolveCommitterIdent(env, config);
 * // { name: "Ada", email: "ada@example.com", timestamp: 1700000000, tzOffset: "+0100" }
 * ```
 *
 * The order, per field, is git's `fmt_ident`:
 *
 * - the name and email: `GIT_AUTHOR_*` / `GIT_COMMITTER_*` (the host environment's `author` /
 *   `committer`), then `author.name` / `committer.name` (and `.email`), then `user.name` /
 *   `user.email`, then `$EMAIL` for the email (the host environment's `defaultEmail`). A
 *   variable set to an empty string counts; an empty `author.*` / `committer.*` does not.
 *   Any `*.email` key in the configuration, even empty, even the other role's, stops the
 *   email there: `user.email`, else empty (`<>`). Likewise `*.name` for the name;
 * - with `user.useConfigOnly`, a commit or tag refuses an identity the configuration does not
 *   give, with git's message ({@link IdentityUnknownError});
 * - a commit or tag refuses an empty name and a name of crud only ({@link InvalidIdentError});
 * - the date: `GIT_AUTHOR_DATE` / `GIT_COMMITTER_DATE` in any form {@link parseGitDate} reads,
 *   else the clock with the local timezone offset.
 *
 * Where git would ask the system (the user's full name from passwd, `user@host`), a portable
 * host knows nothing: the name or email of the command's other identity is used when it was
 * given one explicitly (a commit with only `setAuthor` is committed by that author, dated
 * now), else {@link DEFAULT_IDENT}'s, the identity the ref stores write in reflogs. Never
 * "Unknown", and never an error where git fails to guess.
 */

import type { PersonIdent } from "@statewalker/vcs-core";
import { parseGitBool } from "@statewalker/vcs-utils";
import type { GitHostEnvironment, WorkingCopy } from "@statewalker/vcs-working-tree";

import { GitApiError } from "../errors/index.js";
import { RemoteConfigStore } from "../remote-config/index.js";
import { localTimezoneOffset, parseGitDate } from "./git-date.js";

export { localTimezoneOffset, parseGitDate } from "./git-date.js";

/** The identity of a commit nobody is configured for (the ref stores' reflog identity). */
export const DEFAULT_IDENT = { name: "webrun-vcs", email: "vcs@localhost" } as const;

/** What the resolver reads of the configuration: a value by its key, undefined when unset. */
export interface IdentConfig {
  value(key: string): string | undefined;
}

/** Whose identity: git's `WANT_AUTHOR_IDENT` / `WANT_COMMITTER_IDENT`. */
export type IdentRole = "author" | "committer";

/** How an identity is resolved. */
export interface ResolveIdentOptions {
  /** The clock, in seconds, when the variables give no date (default: now) */
  now?: number;
  /**
   * The name and email used where git would ask the system (the full name from passwd,
   * `user@host`): a command's other, explicitly given identity; {@link DEFAULT_IDENT}
   * otherwise. Never its date: the date is the variables' or the clock's.
   */
  fallback?: Pick<PersonIdent, "name" | "email">;
  /**
   * git's `IDENT_STRICT` (default true, as for commits and tags): `user.useConfigOnly`
   * refuses an identity the configuration does not give, and an empty name or one of crud
   * only is refused ({@link InvalidIdentError}). Reflog lines are not strict.
   */
  strict?: boolean;
}

/** git's `ident_env_hint`: what git prints before refusing an identity it had to look for. */
function identEnvHint(role: IdentRole): string[] {
  return [
    `${role === "author" ? "Author" : "Committer"} identity unknown`,
    "",
    "*** Please tell me who you are.",
    "",
    "Run",
    "",
    '  git config --global user.email "you@example.com"',
    '  git config --global user.name "Your Name"',
    "",
    "to set your account's default identity.",
    "Omit --global to set the identity only in this repository.",
    "",
  ];
}

/**
 * git's refusal of an identity it may not guess (`user.useConfigOnly`): the hint git prints
 * and its `fatal:` line, as the message.
 */
export class IdentityUnknownError extends GitApiError {
  readonly role: IdentRole;
  constructor(role: IdentRole, what: "name" | "email") {
    super(
      [...identEnvHint(role), `fatal: no ${what} was given and auto-detection is disabled`].join(
        "\n",
      ),
    );
    this.name = "IdentityUnknownError";
    this.role = role;
  }
}

/**
 * git's refusal of a name a commit or tag may not carry (`IDENT_STRICT`): an empty one
 * (`empty ident name (for <email>) not allowed`, after the hint when the name came from
 * `user.name`), or one of crud only (`name consists only of disallowed characters: <name>`).
 */
export class InvalidIdentError extends GitApiError {
  readonly role: IdentRole;
  readonly reason: "empty" | "crud";
  /**
   * @param detail the email (for an empty name) or the name (crud only), as given
   * @param hint whether git prints its hint first (the name came from the default)
   */
  constructor(role: IdentRole, reason: "empty" | "crud", detail: string, hint: boolean) {
    const fatal =
      reason === "empty"
        ? `fatal: empty ident name (for <${detail}>) not allowed`
        : `fatal: name consists only of disallowed characters: ${detail}`;
    super([...(hint ? identEnvHint(role) : []), fatal].join("\n"));
    this.name = "InvalidIdentError";
    this.role = role;
    this.reason = reason;
  }
}

/** git's refusal of a `GIT_AUTHOR_DATE` / `GIT_COMMITTER_DATE` it cannot read. */
export class InvalidDateError extends GitApiError {
  readonly date: string;
  constructor(date: string) {
    super(`fatal: invalid date format: ${date}`);
    this.name = "InvalidDateError";
    this.date = date;
  }
}

/** git's `crud`: what `strbuf_addstr_without_crud` trims from the ends of a name or email. */
const isCrud = (c: string) => c <= " " || ",:;<>\"\\'".includes(c);

/**
 * A name or email as git writes it (`strbuf_addstr_without_crud`): crud trimmed from both
 * ends, `<`, `>` and newlines dropped inside.
 */
export function withoutCrud(text: string): string {
  let start = 0;
  let end = text.length;
  while (start < end && isCrud(text[start])) start++;
  while (end > start && isCrud(text[end - 1])) end--;
  return text.slice(start, end).replace(/[<>\n]/g, "");
}

/** git's `has_non_crud`: whether anything but crud is left of a name. */
const hasNonCrud = (text: string) => [...text].some((c) => !isCrud(c));

/**
 * The name and email git's `fmt_ident` finds for `role` before it asks the system, and the
 * date of the variables. A field left undefined is one git would guess (the full name from
 * passwd, `user@host`): the caller fills it.
 */
interface IdentFields {
  name: string | undefined;
  email: string | undefined;
  date: Pick<PersonIdent, "timestamp" | "tzOffset"> | undefined;
}

/**
 * git's `fmt_ident(getenv(GIT_<ROLE>_NAME), getenv(GIT_<ROLE>_EMAIL), ..., GIT_<ROLE>_DATE)`
 * up to the guesses, with its refusals in its order when strict: no email or name given
 * under `user.useConfigOnly`, an empty name, a name of crud only; then an unreadable date.
 * `guessed.email` stands for git's guessed email in the empty-name message.
 */
function identFields(
  role: IdentRole,
  environment: GitHostEnvironment | undefined,
  config: IdentConfig | undefined,
  strict: boolean,
  guessed: { name: string; email: string },
): IdentFields {
  const vars = environment?.[role];
  const value = (key: string) => config?.value(key);
  // git's ident_config_given: any of the *.email (*.name) keys, even empty, even the other
  // role's
  const given = (field: "name" | "email") =>
    ["user", "author", "committer"].some((section) => value(`${section}.${field}`) !== undefined);
  const configOnly = strict && parseGitBool(value("user.useConfigOnly")) === true;

  // the email: GIT_<ROLE>_EMAIL (even empty), <role>.email (unless empty), then
  // ident_default_email: user.email, empty when any *.email key is set, else $EMAIL, else
  // the guess
  let email = vars?.email ?? (value(`${role}.email`) || undefined);
  if (email === undefined) {
    if (configOnly && !given("email")) throw new IdentityUnknownError(role, "email");
    if (given("email")) email = value("user.email") ?? "";
    else if (environment?.defaultEmail) email = environment.defaultEmail.trim();
  }

  // the name: GIT_<ROLE>_NAME (even empty), <role>.name (unless empty), then
  // ident_default_name: user.name, empty when any *.name key is set, else the guess
  let name = vars?.name ?? (value(`${role}.name`) || undefined);
  let usingDefault = false;
  if (name === undefined) {
    if (configOnly && !given("name")) throw new IdentityUnknownError(role, "name");
    usingDefault = true;
    if (given("name")) name = value("user.name") ?? "";
  }
  if (name === "") {
    // git: refused when strict, the login name otherwise (ours: the guess)
    if (strict) throw new InvalidIdentError(role, "empty", email ?? guessed.email, usingDefault);
    name = undefined;
  }
  if (strict && name !== undefined && !hasNonCrud(name)) {
    throw new InvalidIdentError(role, "crud", name, false);
  }

  const dateText = vars?.date !== undefined && vars.date !== "" ? vars.date : undefined;
  const date = dateText !== undefined ? parseGitDate(dateText) : undefined;
  if (dateText !== undefined && !date) throw new InvalidDateError(dateText);
  return { name, email, date };
}

/**
 * git's `fmt_ident` for `role` (not strict unless asked): the identity named by the
 * environment and the configuration, undefined when neither names anyone (no name, email
 * or date): a caller then decides (the reflog's store identity). A field git would guess
 * from the system is {@link DEFAULT_IDENT}'s.
 */
export function findIdent(
  role: IdentRole,
  environment: GitHostEnvironment | undefined,
  config: IdentConfig | undefined,
  options: Omit<ResolveIdentOptions, "fallback"> = {},
): PersonIdent | undefined {
  const fields = identFields(role, environment, config, options.strict !== false, DEFAULT_IDENT);
  if (fields.name === undefined && fields.email === undefined && fields.date === undefined) {
    return undefined;
  }
  return identOf(fields, DEFAULT_IDENT, options.now);
}

/** The identity of `fields`, the guessed ones `guessed`'s, dated by the variables or now. */
function identOf(
  fields: IdentFields,
  guessed: { name: string; email: string },
  now: number | undefined,
): PersonIdent {
  const timestamp = fields.date?.timestamp ?? now ?? Math.floor(Date.now() / 1000);
  return {
    name: withoutCrud(fields.name ?? guessed.name),
    email: withoutCrud(fields.email ?? guessed.email),
    timestamp,
    tzOffset: fields.date?.tzOffset ?? localTimezoneOffset(timestamp),
  };
}

function resolveIdent(
  role: IdentRole,
  environment: GitHostEnvironment | undefined,
  config: IdentConfig | undefined,
  options: ResolveIdentOptions,
): PersonIdent {
  // where git would guess (passwd, user@host): the command's other identity, else ours;
  // only its name and email, never its date
  const guessed = {
    name: options.fallback?.name ?? DEFAULT_IDENT.name,
    email: options.fallback?.email ?? DEFAULT_IDENT.email,
  };
  const fields = identFields(role, environment, config, options.strict !== false, guessed);
  return identOf(fields, guessed, options.now);
}

/**
 * The committer of a commit or the tagger of a tag made now, as git's
 * `git_committer_info(IDENT_STRICT)` resolves it (see the module comment for the order).
 */
export function resolveCommitterIdent(
  environment: GitHostEnvironment | undefined,
  config: IdentConfig | undefined,
  options: ResolveIdentOptions = {},
): PersonIdent {
  return resolveIdent("committer", environment, config, options);
}

/**
 * The author of a commit made now, as git's `git_author_info(IDENT_STRICT)` resolves it
 * (see the module comment for the order).
 */
export function resolveAuthorIdent(
  environment: GitHostEnvironment | undefined,
  config: IdentConfig | undefined,
  options: ResolveIdentOptions = {},
): PersonIdent {
  return resolveIdent("author", environment, config, options);
}

/**
 * The date of an identity made now for `role`: `GIT_AUTHOR_DATE` / `GIT_COMMITTER_DATE`, else
 * `now` (default the clock) in the local offset. git's date of `commit --author=<who>`.
 */
export function resolveIdentDate(
  role: IdentRole,
  environment: GitHostEnvironment | undefined,
  now?: number,
): Pick<PersonIdent, "timestamp" | "tzOffset"> {
  const text = environment?.[role]?.date;
  if (text !== undefined && text !== "") {
    const date = parseGitDate(text);
    if (!date) throw new InvalidDateError(text);
    return date;
  }
  const timestamp = now ?? Math.floor(Date.now() / 1000);
  return { timestamp, tzOffset: localTimezoneOffset(timestamp) };
}

/** The host environment a working copy's configuration carries, if any. */
export function hostEnvironmentOf(workingCopy: WorkingCopy): GitHostEnvironment | undefined {
  return (workingCopy.config as { environment?: GitHostEnvironment } | undefined)?.environment;
}

/** The configuration of a working copy as the resolver reads it. */
export function identConfigOf(workingCopy: WorkingCopy): IdentConfig | undefined {
  return workingCopy.config ? RemoteConfigStore.from(workingCopy) : undefined;
}

/** {@link resolveCommitterIdent} on a working copy's environment and configuration. */
export function committerIdentOf(
  workingCopy: WorkingCopy,
  options: ResolveIdentOptions = {},
): PersonIdent {
  return resolveCommitterIdent(hostEnvironmentOf(workingCopy), identConfigOf(workingCopy), options);
}

/** {@link resolveAuthorIdent} on a working copy's environment and configuration. */
export function authorIdentOf(
  workingCopy: WorkingCopy,
  options: ResolveIdentOptions = {},
): PersonIdent {
  return resolveAuthorIdent(hostEnvironmentOf(workingCopy), identConfigOf(workingCopy), options);
}
