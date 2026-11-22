/**
 * git's proc-receive hook, as receive-pack runs it (builtin/receive-pack.c
 * `proc_receive_ref_matches`, `run_proc_receive_hook`, `read_proc_receive_report`).
 *
 * ```text
 * receive.procReceiveRefs = refs/for        # every command under refs/for/ goes to the hook
 * receive.procReceiveRefs = m:refs/heads    # only updates of existing branches
 * receive.procReceiveRefs = a!:refs/heads   # every creation outside refs/heads/
 * ```
 *
 * The commands whose ref matches are not updated by receive-pack: once pre-receive passed and
 * the pushed objects are published, they are handed to the hook over git's proc-receive
 * protocol (pkt-lines: `version=1` with the `atomic`/`push-options` features, the commands, the
 * push options when the hook asked for them), and the hook answers one `ok <ref>` or
 * `ng <ref> [<reason>]` per command, each `ok` optionally followed by `option refname`,
 * `old-oid`, `new-oid`, `forced-update` (a report the client shows in place of the command:
 * `report-status-v2`) or `fall-through` (receive-pack updates the ref itself after all).
 */

import { PktStream } from "../../fetch-client/pkt-stream.js";
import { encodeFlush, encodePacket } from "../../protocol/pkt-line-codec.js";
import { type PushCommand, type RefPushReport, ZERO_OID } from "./types.js";

/** A command scheduled for the hook (git's `RUN_PROC_RECEIVE_SCHEDULED`). */
export const PROC_RECEIVE_SCHEDULED = 1;
/** The hook reported on the command (git's `RUN_PROC_RECEIVE_RETURNED`). */
export const PROC_RECEIVE_RETURNED = 2;

/**
 * The proc-receive hook started, talked to over its stdin and stdout. Its stderr is the
 * runner's (relayed to the pushing user by the time {@link wait} resolves).
 */
export interface ProcReceiveProcess {
  /**
   * false: the process takes its whole stdin before it answers (a runner that cannot talk to
   * a running hook); receive-pack then writes the version, the commands and the push options
   * at once and closes it before reading. Default true.
   */
  readonly interactive?: boolean;
  /** Writes to the hook's stdin; rejects when the hook closed it */
  write(data: Uint8Array): Promise<void>;
  /** Closes the hook's stdin */
  closeStdin(): Promise<void>;
  /** The hook's stdout */
  readonly stdout: AsyncIterable<Uint8Array>;
  /** Stops reading the hook's stdout (git closes its end: later writes of the hook fail) */
  closeStdout?(): void;
  /** Waits for the hook to exit: its exit code */
  wait(): Promise<number>;
}

/** A `receive.procReceiveRefs` value (git's `struct proc_receive_ref`). */
export interface ProcReceiveRef {
  wantAdd: boolean;
  wantDelete: boolean;
  wantModify: boolean;
  negative: boolean;
  prefix: string;
}

/**
 * git's `proc_receive_ref_append`: `[<modifiers>:]<prefix>`, the modifiers `a` (creations),
 * `d` (deletions), `m` (updates) and `!` (the commands outside the prefix); none: every
 * command. Trailing slashes of the prefix are dropped.
 */
export function parseProcReceiveRef(value: string): ProcReceiveRef {
  const ref: ProcReceiveRef = {
    wantAdd: false,
    wantDelete: false,
    wantModify: false,
    negative: false,
    prefix: "",
  };
  let rest = value;
  const colon = value.indexOf(":");
  if (colon >= 0) {
    for (const c of value.slice(0, colon)) {
      if (c === "a") ref.wantAdd = true;
      else if (c === "d") ref.wantDelete = true;
      else if (c === "m") ref.wantModify = true;
      else if (c === "!") ref.negative = true;
    }
    rest = value.slice(colon + 1);
  } else {
    ref.wantAdd = ref.wantDelete = ref.wantModify = true;
  }
  ref.prefix = rest.replace(/\/+$/, "");
  return ref;
}

/** git's `proc_receive_ref_matches`: whether the command goes to the proc-receive hook. */
export function procReceiveRefMatches(
  refs: readonly ProcReceiveRef[],
  cmd: Pick<PushCommand, "refName" | "oldOid" | "newOid">,
): boolean {
  for (const p of refs) {
    const isAdd = cmd.oldOid === ZERO_OID;
    const isDelete = cmd.newOid === ZERO_OID;
    if (!p.wantAdd && isAdd) continue;
    if (!p.wantDelete && isDelete) continue;
    if (!p.wantModify && !isAdd && !isDelete) continue;
    const name = cmd.refName;
    const under =
      name.startsWith(p.prefix) &&
      (name.length === p.prefix.length || name[p.prefix.length] === "/");
    if (under) {
      if (!p.negative) return true;
    } else if (p.negative) {
      return true;
    }
  }
  return false;
}

/** A push command as the proc-receive hook handles it. */
export type ProcReceiveCommand = PushCommand;

const encoder = new TextEncoder();

function hasError(cmd: PushCommand): boolean {
  return cmd.result !== "NOT_ATTEMPTED";
}

function fail(cmd: PushCommand, message: string): void {
  cmd.result = "REJECTED_OTHER_REASON";
  cmd.message = message;
}

/** git's `parse_oid_hex` on the start of `value`: a lowercase id, or undefined. */
function parseOidHex(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const hex = value.slice(0, 40);
  return /^[0-9a-fA-F]{40}$/.test(hex) ? hex.toLowerCase() : undefined;
}

/** C's `atoi`: the leading decimal number (after blanks and a sign), 0 when none. */
function atoi(text: string): number {
  const m = /^[ \t\n\v\f\r]*([+-]?\d+)/.exec(text);
  return m ? Number.parseInt(m[1], 10) | 0 : 0;
}

/** Whether `name` is among the space-separated features (git's `parse_feature_request`). */
function hasFeature(list: string, name: string): boolean {
  return list.split(" ").some((f) => f === name || f.startsWith(`${name}=`));
}

/** The next pkt-line of the hook: its text, "flush", or "eof" (end, or a broken packet). */
async function readPkt(pkts: PktStream): Promise<string | "flush" | "eof"> {
  try {
    const p = await pkts.read();
    if (!p) return "eof";
    if (p.type !== "data") return "flush";
    return p.text;
  } catch {
    return "eof";
  }
}

/**
 * git's `read_proc_receive_report`: reads the hook's answer up to its flush, sets each
 * command's outcome (`ng` refuses it, `ok` marks it returned, its `option` lines add reports,
 * `fall-through` gives it back to receive-pack) and adds git's error lines to `errors`. 0 when
 * the report holds no error, else -1.
 */
async function readProcReceiveReport(
  pkts: PktStream,
  commands: ProcReceiveCommand[],
  errors: string[],
): Promise<number> {
  let hint: ProcReceiveCommand | undefined;
  let report: RefPushReport | undefined;
  let newReport = false;
  let code = 0;
  let once = false;
  let response = 0;
  const findFrom = (start: number, ref: string) => {
    for (let i = start; i < commands.length; i++) if (commands[i].refName === ref) return i;
    return -1;
  };
  for (;;) {
    const line = await readPkt(pkts);
    if (line === "eof" || line === "flush") {
      if (line === "eof" && response === 0) {
        errors.push("proc-receive exited abnormally");
        return -1;
      }
      break;
    }
    response++;
    // strchr stops at a NUL as C strings do
    const text = line.includes("\0") ? line.slice(0, line.indexOf("\0")) : line;
    const space = text.indexOf(" ");
    if (space < 0) {
      errors.push(`proc-receive reported incomplete status line: '${text}'\n`);
      code = -1;
      continue;
    }
    const head = text.slice(0, space);
    let p: string | undefined = text.slice(space + 1);
    if (head === "option") {
      if (!hint || !(report || newReport)) {
        if (!once) {
          once = true;
          errors.push("proc-receive reported 'option' without a matching 'ok/ng' directive\n");
        }
        code = -1;
        continue;
      }
      if (newReport) {
        hint.reports ??= [];
        report = {};
        hint.reports.push(report);
        newReport = false;
      }
      const target = report as RefPushReport;
      const keyEnd = p.indexOf(" ");
      const key = keyEnd < 0 ? p : p.slice(0, keyEnd);
      const val = keyEnd < 0 ? undefined : p.slice(keyEnd + 1);
      if (key === "refname") {
        if (val === undefined) delete target.refName;
        else target.refName = val;
      } else if (key === "old-oid" && parseOidHex(val) !== undefined) {
        target.oldOid = parseOidHex(val);
      } else if (key === "new-oid" && parseOidHex(val) !== undefined) {
        target.newOid = parseOidHex(val);
      } else if (key === "forced-update") {
        target.forcedUpdate = true;
      } else if (key === "fall-through") {
        // receive-pack updates the ref itself
        hint.procReceive = 0;
      }
      continue;
    }

    report = undefined;
    newReport = false;
    const refEnd = p.indexOf(" ");
    const refName = refEnd < 0 ? p : p.slice(0, refEnd);
    p = refEnd < 0 ? undefined : p.slice(refEnd + 1);
    if (head !== "ok" && head !== "ng") {
      errors.push(`proc-receive reported bad status '${head}' on ref '${refName}'\n`);
      code = -1;
      continue;
    }
    // first from the hint on, then from the start
    let index = hint ? findFrom(commands.indexOf(hint), refName) : -1;
    if (index < 0) index = findFrom(0, refName);
    hint = index < 0 ? undefined : commands[index];
    if (!hint) {
      errors.push(`proc-receive reported status on unknown ref: ${refName}\n`);
      code = -1;
      continue;
    }
    if (!hint.procReceive) {
      errors.push(`proc-receive reported status on unexpected ref: ${refName}\n`);
      code = -1;
      continue;
    }
    hint.procReceive |= PROC_RECEIVE_RETURNED;
    if (head === "ng") {
      fail(hint, p ?? "failed");
      code = -1;
      continue;
    }
    newReport = true;
  }

  for (const cmd of commands) {
    if (cmd.procReceive && !hasError(cmd) && !(cmd.procReceive & PROC_RECEIVE_RETURNED)) {
      fail(cmd, "proc-receive failed to report status");
      code = -1;
    }
  }
  return code;
}

/** What {@link runProcReceive} was told about the push. */
export interface ProcReceiveRun {
  /** The client asked for an atomic push (the `atomic` feature) */
  atomic: boolean;
  /** The client sent push options (the `push-options` feature), and those options */
  pushOptions?: readonly string[];
}

/**
 * git's `run_proc_receive_hook`: negotiates the version with the hook, sends it the commands
 * scheduled for it (not refused meanwhile) and the push options it asked for, reads its
 * report ({@link readProcReceiveReport}) and waits for it. Returns 0, or -1 when anything
 * failed (the hook's exit code included), with git's error text (the `rp_error` receive-pack
 * prints, its last newline dropped) in `error`.
 */
export async function runProcReceive(
  process: ProcReceiveProcess | undefined,
  commands: ProcReceiveCommand[],
  run: ProcReceiveRun,
): Promise<{ code: number; error?: string }> {
  if (!process) return { code: -1, error: "cannot find hook 'proc-receive'" };
  const errors: string[] = [];
  const interactive = process.interactive !== false;
  const pkts = new PktStream(process.stdout);
  let code = 0;
  const write = async (chunks: Uint8Array[]): Promise<boolean> => {
    try {
      for (const chunk of chunks) await process.write(chunk);
      return true;
    } catch {
      return false;
    }
  };

  const features = [
    ...(run.atomic ? ["atomic"] : []),
    ...(run.pushOptions ? ["push-options"] : []),
  ];
  const versionLine = features.length > 0 ? `version=1\0${features.join(" ")}\n` : "version=1\n";
  const commandLines = () =>
    commands
      .filter((c) => c.procReceive && !hasError(c))
      .map((c) => encodePacket(`${c.oldOid} ${c.newOid} ${c.refName}`));
  const optionLines = () =>
    (run.pushOptions ?? []).map((option) => encodePacket(option)).concat(encodeFlush());

  try {
    let version = 0;
    let usePushOptions = false;
    if (!interactive) {
      // the whole conversation at once: the hook's push-options answer cannot be waited for
      const ok = await write([
        encodePacket(versionLine),
        encodeFlush(),
        ...commandLines(),
        encodeFlush(),
        ...(run.pushOptions ? optionLines() : []),
      ]);
      await process.closeStdin().catch(() => {});
      if (!ok) code = -1;
    } else if (!(await write([encodePacket(versionLine), encodeFlush()]))) {
      code = -1;
    }
    if (code === 0) {
      for (;;) {
        const line = await readPkt(pkts);
        if (line === "eof") {
          code = -1;
          break;
        }
        if (line === "flush") break;
        const bytes = encoder.encode(line).length;
        if (bytes > 8 && line.startsWith("version=")) {
          version = atoi(line.slice(8));
          const nul = line.indexOf("\0");
          if (nul >= 0 && hasFeature(line.slice(nul + 1), "push-options")) usePushOptions = true;
        }
      }
    }
    if (code !== 0) {
      errors.push("fail to negotiate version with proc-receive hook");
    } else if (version !== 0 && version !== 1) {
      errors.push(`proc-receive version '${version}' is not supported`);
      code = -1;
    } else {
      if (interactive) {
        if (!(await write([...commandLines(), encodeFlush()]))) {
          errors.push("fail to write commands to proc-receive hook");
          code = -1;
        } else if (usePushOptions && !(await write(optionLines()))) {
          errors.push("fail to write push-options to proc-receive hook");
          code = -1;
        }
      }
      if (code === 0) code = await readProcReceiveReport(pkts, commands, errors);
    }
  } finally {
    // git closes both pipes, then waits for the hook
    await process.closeStdin().catch(() => {});
    process.closeStdout?.();
    await pkts.cancel();
  }
  const exitCode = await process.wait().catch(() => 1);
  if (exitCode !== 0) code = -1;
  let error = errors.join("");
  if (error.endsWith("\n")) error = error.slice(0, -1);
  return error ? { code, error } : { code };
}

/**
 * receive-pack's `report_v2` lines of one command: `ok <ref>` and the options of each report
 * (another `ok <ref>` before each later one), or `ng <ref> <reason>`.
 */
export function reportV2Lines(cmd: ProcReceiveCommand, ngReason: string): string[] {
  if (cmd.result !== "OK") return [`ng ${cmd.refName} ${ngReason}`];
  const lines = [`ok ${cmd.refName}`];
  (cmd.reports ?? []).forEach((report, i) => {
    if (i > 0) lines.push(`ok ${cmd.refName}`);
    if (report.refName !== undefined) lines.push(`option refname ${report.refName}`);
    if (report.oldOid !== undefined) lines.push(`option old-oid ${report.oldOid}`);
    if (report.newOid !== undefined) lines.push(`option new-oid ${report.newOid}`);
    if (report.forcedUpdate) lines.push("option forced-update");
  });
  return lines;
}
