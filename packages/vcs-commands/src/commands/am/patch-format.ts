/**
 * The patch formats `git am` reads besides mailboxes (builtin/am.c): the detection of a
 * file's format (`detect_patch_format`) and the conversion of StGit and Mercurial patches
 * to mails (`stgit_patch_to_mail`, `hg_patch_to_mail`). Contents are binary strings.
 */

import { formatRfc2822Date } from "../git-date.js";

/** A patch format `git am` reads (`--patch-format`). */
export type AmPatchFormat = "mbox" | "mboxrd" | "stgit" | "stgit-series" | "hg";

/** `strbuf_getline`: the lines of a text without their LF (and a CR before it). */
function getlines(text: string): string[] {
  const out: string[] = [];
  let at = 0;
  while (at < text.length) {
    const nl = text.indexOf("\n", at);
    let end = nl < 0 ? text.length : nl;
    const next = nl < 0 ? text.length : nl + 1;
    if (nl >= 0 && end > at && text[end - 1] === "\r") end--;
    out.push(text.slice(at, end));
    at = next;
  }
  return out;
}

/** `is_mail`: whether the header lines (up to the first blank one) all look like headers. */
function isMail(lines: string[]): boolean {
  for (const line of lines) {
    if (!line.length) break;
    if (line[0] === "\t" || line[0] === " ") continue;
    if (!/^[!-9;-~]+:/.test(line)) return false;
  }
  return true;
}

/**
 * `detect_patch_format` of a file's content: its format, undefined when it is none git
 * recognises ("Patch format detection failed.").
 */
export function detectPatchFormat(content: string): AmPatchFormat | undefined {
  const lines = getlines(content);
  let i = 0;
  while (i < lines.length && !(lines[i] as string).length) i++;
  const l1 = lines[i] ?? "";
  if (l1.startsWith("From ") || l1.startsWith("From: ")) return "mbox";
  if (l1.startsWith("# This series applies on GIT commit")) return "stgit-series";
  if (l1 === "# HG changeset patch") return "hg";
  const l2 = lines[i + 1] ?? "";
  const l3 = lines[i + 2] ?? "";
  if (l1.length && !l2.length && /^(From:|Author:|Date:)/.test(l3)) return "stgit";
  if (l1.length && isMail(lines)) return "mbox";
  return undefined;
}

/** `strbuf_getline_lf` lines (each without its LF) and where each ends. */
function splitLf(text: string): { line: string; end: number }[] {
  const out: { line: string; end: number }[] = [];
  let at = 0;
  while (at < text.length) {
    const nl = text.indexOf("\n", at);
    const end = nl < 0 ? text.length : nl + 1;
    out.push({ line: text.slice(at, nl < 0 ? text.length : nl), end });
    at = end;
  }
  return out;
}

const isAllSpace = (s: string) => /^[ \t\n\v\f\r]*$/.test(s);

/** `stgit_patch_to_mail`: an StGit patch as a mail. */
export function stgitPatchToMail(patch: string): string {
  let out = "";
  let subjectPrinted = false;
  for (const { line, end } of splitLf(patch)) {
    if (isAllSpace(line)) continue;
    if (line.startsWith("Author:")) out += `From:${line.slice(7)}\n`;
    else if (line.startsWith("From") || line.startsWith("Date")) out += `${line}\n`;
    else if (!subjectPrinted) {
      out += `Subject: ${line}\n`;
      subjectPrinted = true;
    } else {
      out += `\n${line}\n`;
      return out + patch.slice(end);
    }
  }
  return out;
}

/**
 * `hg_patch_to_mail`: a Mercurial patch (`hg export`) as a mail; its error ("invalid Date
 * line", ...) when the header does not parse.
 */
export function hgPatchToMail(patch: string): { mail: string } | { error: string } {
  let out = "";
  for (const { line, end } of splitLf(patch)) {
    if (line.startsWith("# User ")) out += `From: ${line.slice(7)}\n`;
    else if (line.startsWith("# Date ")) {
      const m = /^(\d*)(.*)$/s.exec(line.slice(7)) as RegExpExecArray;
      const timestamp = Number(m[1] || 0);
      if (!Number.isSafeInteger(timestamp)) return { error: "invalid timestamp" };
      if (!(m[2] as string).startsWith(" ")) return { error: "invalid Date line" };
      const tzText = (m[2] as string).slice(1);
      // strtol: leading space, a sign, digits; anything after them is an invalid line
      const t = /^[ \t\n\v\f\r]*([+-]?\d*)(.*)$/s.exec(tzText) as RegExpExecArray;
      if (t[2]) return { error: "invalid Date line" };
      const tz = Number(/\d/.test(t[1] as string) ? t[1] : 0);
      // seconds west of UTC to hours and minutes east
      const abs = Math.abs(tz);
      const hhmm = Math.trunc(abs / 3600) * 100 + Math.trunc((abs % 3600) / 60);
      const tz2 = tz > 0 ? -hhmm : hhmm;
      const offset = `${tz2 < 0 ? "-" : "+"}${String(Math.abs(tz2)).padStart(4, "0")}`;
      out += `Date: ${formatRfc2822Date(timestamp, offset)}\n`;
    } else if (!line.startsWith("# ")) {
      out += `\n${line}\n`;
      return { mail: out + patch.slice(end) };
    }
  }
  return { mail: out };
}
