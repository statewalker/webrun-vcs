/**
 * `git url-parse` (builtin/url-parse.c, git 2.5x): each URL parsed as git reads remote URLs
 * (`url_parse`), printing the component asked for, or dying on the first URL git refuses.
 *
 * @example
 * ```typescript
 * // git url-parse -c host user@example.com:repo.git
 * await git.urlParse().setComponent("host").addUrl("user@example.com:repo.git").call();
 * // { exitCode: 0, stdout: "example.com\n", stderr: "" }
 * ```
 */

import { URL_COMPONENTS, type UrlComponent, urlComponent, urlParse } from "@statewalker/vcs-utils";

import { GitCommand } from "../git-command.js";
import type { PlumbingTextOutput } from "./check-ref-format-command.js";

const USAGE =
  "usage: git url-parse [-c <component>] [--] <url>...\n\n" +
  "    -c, --[no-]component <component>\n" +
  "                          which URL component to extract\n\n";

/**
 * `git url-parse [-c <component>] <url>...`: every URL checked in order, the component of
 * each printed (an empty line when the URL has none); nothing printed without a component.
 * A URL git refuses ends the run with git's `fatal:` line (exit 128) after the earlier URLs'
 * lines; an unknown component dies before any URL is read, no URL prints the usage (129).
 */
export class UrlParseCommand extends GitCommand<PlumbingTextOutput> {
  private readonly urls: string[] = [];
  private component?: string;

  /** A URL to parse. */
  addUrl(url: string): this {
    this.checkCallable();
    this.urls.push(url);
    return this;
  }

  /** `-c <component>`: `scheme`, `user`, `password`, `host`, `port` or `path`. */
  setComponent(component: UrlComponent | string | undefined): this {
    this.checkCallable();
    this.component = component;
    return this;
  }

  async call(): Promise<PlumbingTextOutput> {
    this.checkCallable();
    this.setCallable(false);
    if (this.urls.length === 0) return { exitCode: 129, stdout: "", stderr: USAGE };
    const component = this.component;
    if (component !== undefined && !URL_COMPONENTS.includes(component as UrlComponent)) {
      return {
        exitCode: 128,
        stdout: "",
        stderr: `fatal: invalid git URL component '${component}'\n`,
      };
    }
    let stdout = "";
    for (const url of this.urls) {
      const parsed = urlParse(url);
      if ("error" in parsed) return { exitCode: 128, stdout, stderr: `fatal: ${parsed.error}\n` };
      if (component !== undefined) stdout += `${urlComponent(parsed, component as UrlComponent)}\n`;
    }
    return { exitCode: 0, stdout, stderr: "" };
  }
}
