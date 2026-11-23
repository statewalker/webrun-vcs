/**
 * The report of a push as git prints it on stderr (transport.c `transport_print_push_status`):
 * `To <url>`, then one line per ref, ` <flag> <summary> <from> -> <to> (<reason>)`, the
 * summary column `transport_summary_width` wide.
 *
 * @example
 * ```typescript
 * const result = await push({ url, repository, refStore, refspecs: ["main"] });
 * process.stderr.write(formatPushStatus(result, { dest: url }).map((l) => `${l}\n`).join(""));
 * // To https://example.com/repo.git
 * //    1a2b3c4..5d6e7f8  main -> main
 * ```
 */

import { anonymizeUrl } from "../fetch-client/index.js";
import { isNullId } from "../protocol/object-format.js";
import {
  type AbbrevLengths,
  abbreviate,
  padSummary,
  prettifyRefName,
  transportSummaryWidth,
} from "../summary/index.js";
import type { PushRefReport, PushRefUpdate } from "./push-refs.js";

/** One ref's line, as git's `print_ref_status` takes it. */
export interface PushStatusParts {
  /** `=` up to date, ` ` fast-forward, `+` forced, `*` new, `-` deleted, `!` refused */
  flag: string;
  /** The status column: `[new branch]`, `1a2b3c4..5d6e7f8`, `[rejected]`, … */
  summary: string;
  /** The local side (`from -> to`); undefined where git prints the remote ref alone */
  from?: string;
  /** The reason in parentheses: `non-fast-forward`, `forced update`, the server's reason */
  message?: string;
}

/**
 * The flag, summary, local side and reason of an update, as git's `print_one_push_report` and
 * `print_ok_ref_status` choose them; ids abbreviated by `lengths` (7 digits without). With a
 * `report` (one of `update.reports`, a rewrite the server's proc-receive hook reported), an
 * accepted update is shown with the report's old and new ids, ref and forced flag where it
 * gives them.
 */
export function pushStatusParts(
  update: PushRefUpdate,
  lengths?: AbbrevLengths,
  report?: PushRefReport,
): PushStatusParts {
  const deletion = isNullId(update.newOid);
  // the local side: the ref pushed, else the source as written (`HEAD`, `HEAD~1`, an id),
  // a delete's "(delete)" (alloc_delete_ref)
  const peer = update.source ?? update.localRef ?? (deletion ? "(delete)" : update.newOid);
  const rejected = (message: string): PushStatusParts => ({
    flag: "!",
    summary: "[rejected]",
    from: peer,
    message,
  });
  switch (update.status) {
    case "up-to-date":
      return { flag: "=", summary: "[up to date]", from: peer };
    case "rejected-nonfastforward":
      return rejected("non-fast-forward");
    case "rejected-fetch-first":
      return rejected("fetch first");
    case "rejected-needs-force":
      return rejected("needs force");
    case "rejected-already-exists":
      return rejected("already exists");
    case "rejected-stale":
      return rejected("stale info");
    case "atomic-push-failed":
      return rejected("atomic push failed");
    case "rejected-nodelete":
      return { flag: "!", summary: "[rejected]", message: "remote does not support deleting refs" };
    case "remote-rejected":
      return {
        flag: "!",
        summary: "[remote rejected]",
        ...(deletion ? {} : { from: peer }),
        message: update.message ?? "failed",
      };
    case "remote-failure":
      return {
        flag: "!",
        summary: "[remote failure]",
        ...(deletion ? {} : { from: peer }),
        message: "remote failed to report status",
      };
    case "ok": {
      if (deletion) return { flag: "-", summary: "[deleted]" };
      const oldOid = report?.oldOid ?? update.oldOid;
      const newOid = report?.newOid ?? update.newOid;
      if (isNullId(oldOid)) {
        const name = report?.refName ?? update.remoteRef;
        const summary = name.startsWith("refs/tags/")
          ? "[new tag]"
          : name.startsWith("refs/heads/")
            ? "[new branch]"
            : "[new reference]";
        return { flag: "*", summary, from: peer };
      }
      const range = (dots: string) =>
        `${abbreviate(oldOid, lengths)}${dots}${abbreviate(newOid, lengths)}`;
      if (report?.forcedUpdate || update.forced) {
        return { flag: "+", summary: range("..."), from: peer, message: "forced update" };
      }
      return { flag: " ", summary: range(".."), from: peer };
    }
  }
}

/**
 * The ids `transport_summary_width` measures: each advertised ref's value and what it is
 * pushed to (the null id when not pushed), then each new remote ref's absent old value
 * and its new one.
 */
export function pushSummaryIds(
  remoteRefs: readonly { name: string; oid?: string }[],
  updates: readonly PushRefUpdate[],
): string[] {
  const byRef = new Map(updates.map((u) => [u.remoteRef, u]));
  const ids: string[] = [];
  const advertised = new Set<string>();
  for (const r of remoteRefs) {
    if (!r.oid || r.name.endsWith("^{}") || advertised.has(r.name)) continue;
    advertised.add(r.name);
    ids.push(r.oid, byRef.get(r.name)?.newOid ?? "0".repeat(r.oid.length === 64 ? 64 : 40));
  }
  for (const u of updates) if (!advertised.has(u.remoteRef)) ids.push(u.oldOid, u.newOid);
  return ids;
}

/** Options of {@link formatPushStatus}. */
export interface FormatPushStatusOptions {
  /** The remote as given (`To <dest>`, its user and password left out) */
  dest: string;
  /** Also the refs already up to date (`git push -v`) */
  verbose?: boolean;
  /**
   * `git push --porcelain`: the lines git prints on stdout (`To <dest>`, then
   * `<flag>\t<from>:<to>\t<summary> (<reason>)` per ref, every ref up to date included, and
   * `Done` once the server's report was read), no `Everything up-to-date`
   */
  porcelain?: boolean;
}

/** What {@link formatPushStatus} reads of a push result. */
export interface PushStatusSource {
  /** The refs the remote advertised */
  remoteRefs: readonly { name: string; oid?: string }[];
  /** The updates, with their statuses */
  updates: readonly PushRefUpdate[];
  /** The abbreviated lengths of the ids (`PushClientResult.abbrevLengths`) */
  abbrevLengths?: AbbrevLengths;
  /** The summary column's width (`PushClientResult.summaryWidth`) */
  summaryWidth?: number;
  /** The server's `unpack` line (`PushClientResult.unpack`): `Done` needs it ok under porcelain */
  unpack?: { ok: boolean; message?: string };
  /** The server's report was broken (`PushClientResult.reportFailed`): no `Done` */
  reportFailed?: boolean;
}

/**
 * The lines git prints on stderr for a push (`transport_print_push_status`): `To <dest>` and
 * the refs, those pushed first, then those refused, each group in the remote's order (the
 * advertised refs, then the new ones); `Everything up-to-date` when nothing was pushed or
 * refused. Without `verbose`, refs already up to date are left out.
 */
export function formatPushStatus(
  result: PushStatusSource,
  options: FormatPushStatusOptions,
): string[] {
  const lengths = result.abbrevLengths;
  const width =
    result.summaryWidth ??
    transportSummaryWidth(pushSummaryIds(result.remoteRefs, result.updates), lengths);
  const order = new Map<string, number>();
  for (const r of result.remoteRefs) if (!order.has(r.name)) order.set(r.name, order.size);
  const sorted = result.updates
    .map((u, i) => ({ u, key: order.get(u.remoteRef) ?? order.size + i }))
    .sort((a, b) => a.key - b.key)
    .map((e) => e.u);
  const lines: string[] = [];
  const porcelain = options.porcelain === true;
  // print_ref_status, once per report of the server (print_one_push_status)
  const printOne = (u: PushRefUpdate, report?: PushRefReport) => {
    if (lines.length === 0) lines.push(`To ${anonymizeUrl(options.dest)}`);
    const p = pushStatusParts(u, lengths, report);
    const toName = report?.refName ?? u.remoteRef;
    if (porcelain) {
      let line =
        p.from !== undefined ? `${p.flag}\t${p.from}:${toName}\t` : `${p.flag}\t:${toName}\t`;
      line += p.message !== undefined ? `${p.summary} (${p.message})` : p.summary;
      lines.push(line);
      return;
    }
    const to = prettifyRefName(toName);
    let line = ` ${p.flag} ${padSummary(p.summary, width)} `;
    line += p.from !== undefined ? `${prettifyRefName(p.from)} -> ${to}` : to;
    if (p.message !== undefined) line += ` (${p.message})`;
    lines.push(line);
  };
  const print = (u: PushRefUpdate) => {
    if (!u.reports?.length) printOne(u);
    else for (const report of u.reports) printOne(u, report);
  };
  if (options.verbose || porcelain) {
    for (const u of sorted) if (u.status === "up-to-date") print(u);
  }
  for (const u of sorted) if (u.status === "ok") print(u);
  for (const u of sorted) if (u.status !== "ok" && u.status !== "up-to-date") print(u);
  if (porcelain) {
    // send_pack returns 0 under --porcelain once the report is read (refused refs or not)
    const failed =
      result.unpack?.ok === false ||
      result.reportFailed === true ||
      result.updates.some((u) => u.status === "atomic-push-failed");
    if (!failed) lines.push("Done");
    return lines;
  }
  // push.c: nothing pushed and nothing refused
  if (!result.reportFailed && !result.updates.some((u) => u.status !== "up-to-date")) {
    lines.push("Everything up-to-date");
  }
  return lines;
}
