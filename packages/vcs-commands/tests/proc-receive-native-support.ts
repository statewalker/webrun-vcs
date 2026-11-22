/**
 * What the proc-receive native twins share: git's `test-tool proc-receive` (t/helper/
 * test-proc-receive.c) as a Node script, and a proc-receive hook (a shell script, as t5411's
 * `test_hook`) that runs it with the options given. The tool reads receive-pack's pkt-lines
 * as they come (blocking reads on fd 0), answers the version and the reports asked for with
 * `-r`, writes `-v`'s lines to stderr, and appends what it read (and the variables and
 * directory it runs with) to `$HOOK_LOG`, as `hooks-native-support.ts`'s logging hook does.
 */
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** The Node source of `test-tool proc-receive`. */
export const PROC_RECEIVE_TOOL = String.raw`
const fs = require("node:fs");
const args = process.argv.slice(2);
const opt = { returns: [], version: 1 };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === "-v" || a === "--verbose") opt.verbose = true;
  else if (a === "-r" || a === "--return") opt.returns.push(args[++i]);
  else if (a === "-V" || a === "--version") opt.version = Number(args[++i]);
  else if (a.startsWith("--")) opt[a.slice(2)] = true;
}
const read = [];
function log() {
  if (!process.env.HOOK_LOG) return;
  let text = "== proc-receive\n";
  const extra = (process.env.HOOK_EXTRA_VARS || "").split(" ").filter(Boolean);
  for (const v of ["GIT_INDEX_FILE", "GIT_EDITOR", "GIT_PREFIX", "GIT_DIR", "GIT_WORK_TREE",
    "GIT_REFLOG_ACTION", "GIT_PUSH_OPTION_COUNT", "GIT_QUARANTINE_PATH", "REMOTE_USER", ...extra]) {
    if (process.env[v] !== undefined) text += v + "=" + process.env[v] + "\n";
  }
  text += "pwd=" + process.cwd() + "\n";
  if (read.length) text += "stdin:\n" + read.join("\n") + "\n";
  fs.appendFileSync(process.env.HOOK_LOG, text);
}
function die(msg) {
  log();
  process.stderr.write("fatal: " + msg + "\n");
  process.exit(128);
}
let pending = Buffer.alloc(0);
function fill(n) {
  while (pending.length < n) {
    const buf = Buffer.alloc(65536);
    let got = 0;
    try { got = fs.readSync(0, buf, 0, buf.length, null); } catch (e) {
      if (e.code === "EAGAIN") continue;
      got = 0;
    }
    if (got === 0) return false;
    pending = Buffer.concat([pending, buf.subarray(0, got)]);
  }
  return true;
}
// packet_reader_read with CHOMP_NEWLINE | GENTLE_ON_EOF: a line, "flush", or "eof"
function readPkt() {
  if (!fill(4)) return "eof";
  const len = parseInt(pending.subarray(0, 4).toString("latin1"), 16);
  if (len === 0) { pending = pending.subarray(4); read.push("0000"); return "flush"; }
  if (!fill(len)) return "eof";
  let line = pending.subarray(4, len).toString("latin1");
  pending = pending.subarray(len);
  if (line.endsWith("\n")) line = line.slice(0, -1);
  read.push(line.replace(/\0/g, "\\0"));
  return line;
}
function write(text) {
  try { fs.writeSync(1, text); } catch (e) { die("packet write failed"); }
}
const pkt = (line) => (line.length + 4).toString(16).padStart(4, "0") + line;
let useAtomic = false;
let usePushOptions = false;
if (opt["die-read-version"]) die("die with the --die-read-version option");
for (;;) {
  const line = readPkt();
  if (line === "eof" || line === "flush") break;
  if (opt.version === 0) continue;
  if (line.length > 8 && line.startsWith("version=")) {
    const v = parseInt(line.slice(8), 10) || 0;
    if (v !== 1) die("bad protocol version: " + v);
    const nul = line.indexOf("\0");
    if (nul >= 0) {
      const features = line.slice(nul + 1).split(" ");
      if (features.includes("atomic")) useAtomic = true;
      if (features.includes("push-options")) usePushOptions = true;
    }
  }
}
if (opt["die-write-version"]) die("die with the --die-write-version option");
if (opt.version !== 0) {
  write(pkt("version=" + opt.version + "\0" +
    (usePushOptions && !opt["no-push-options"] ? "push-options" : "") + "\n"));
}
write("0000");
const commands = [];
for (;;) {
  const line = readPkt();
  if (line === "eof" || line === "flush") break;
  if (opt["die-read-commands"]) die("die with the --die-read-commands option");
  const m = /^([0-9a-f]{40}) ([0-9a-f]{40}) (.*)$/.exec(line);
  if (!m) die("protocol error: expected 'old new ref', got '" + line + "'");
  commands.push(m.slice(1).join(" "));
}
const pushOptions = [];
if (!opt["no-push-options"] && usePushOptions) {
  if (opt["die-read-push-options"]) die("die with the --die-read-push-options option");
  for (;;) {
    const line = readPkt();
    if (line === "eof" || line === "flush") break;
    pushOptions.push(line);
  }
}
if (opt.verbose) {
  let out = "";
  if (usePushOptions || useAtomic) {
    out += "proc-receive:" + (useAtomic ? " atomic" : "") + (usePushOptions ? " push_options" : "") + "\n";
  }
  for (const c of commands) out += "proc-receive< " + c + "\n";
  for (const o of pushOptions) out += "proc-receive< " + o + "\n";
  for (const r of opt.returns) out += "proc-receive> " + r + "\n";
  process.stderr.write(out);
}
if (opt["die-write-report"]) die("die with the --die-write-report option");
for (const r of opt.returns) write(pkt(r + "\n"));
write("0000");
log();
`;

/** Writes the tool to `<dir>/proc-receive-tool.cjs`, once per directory: its path. */
export function writeProcReceiveTool(dir: string): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "proc-receive-tool.cjs");
  writeFileSync(path, PROC_RECEIVE_TOOL);
  return path;
}

/** Shell-quotes one argument. */
const quote = (arg: string) => `'${arg.replace(/'/g, `'\\''`)}'`;

/**
 * Installs `<hooks>/proc-receive`: `printf >&2 "# proc-receive hook\n"` then the tool with
 * `args` (t5411's `test-tool proc-receive -v -r ...`).
 */
export function installProcReceive(hooks: string, tool: string, args: string[]): void {
  mkdirSync(hooks, { recursive: true });
  const path = join(hooks, "proc-receive");
  writeFileSync(
    path,
    `#!/bin/sh\nprintf >&2 "# proc-receive hook\\n"\nexec ${quote(process.execPath)} ${quote(tool)} ${args.map(quote).join(" ")}\n`,
  );
  chmodSync(path, 0o755);
}
