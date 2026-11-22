/**
 * The proc-receive hook in receive-pack (`receive.procReceiveRefs`, git's proc-receive
 * protocol, report-status-v2): matching, the conversation with a scripted hook process (an
 * interactive one and one that takes its whole stdin first), the reports relayed to the
 * client, and post-receive told the rewrites.
 */

import { describe, expect, it } from "vitest";

import {
  type ProcReceiveProcess,
  parseProcReceiveRef,
  procReceiveRefMatches,
  type ReceiveCommand,
} from "../src/index.js";
import {
  clientWithNewCommits,
  fullPackOf,
  runReceivePack,
  serverRepo,
  ZERO,
} from "./helpers/receive-pack-harness.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const pkt = (line: string) =>
  `${(encoder.encode(line).length + 4).toString(16).padStart(4, "0")}${line}`;

/**
 * A scripted hook: answers the version (`version=1`, with push-options when `pushOptions`),
 * then `report` once it read the commands (and the options it asked for); records what it
 * read as pkt-line texts ("0000" for a flush).
 */
function scriptedHook(
  report: string[],
  options: { version?: number; pushOptions?: boolean; interactive?: boolean; exit?: number } = {},
): { process: ProcReceiveProcess; read: string[] } {
  const read: string[] = [];
  let input = "";
  const answer: string[] = [];
  let wake: (() => void) | undefined;
  let stage = 0;
  const parse = () => {
    for (;;) {
      if (input.length < 4) return;
      const len = Number.parseInt(input.slice(0, 4), 16);
      if (len === 0) {
        input = input.slice(4);
        read.push("0000");
        stage++;
        if (stage === 1) {
          answer.push(
            pkt(`version=${options.version ?? 1}\0${options.pushOptions ? "push-options" : ""}\n`),
            "0000",
          );
        }
        const done = options.pushOptions ? 3 : 2;
        if (stage === done) answer.push(...report.map((l) => pkt(`${l}\n`)), "0000");
        wake?.();
        continue;
      }
      if (input.length < len) return;
      read.push(input.slice(4, len).replace(/\n$/, "").replace(/\0/g, "\\0"));
      input = input.slice(len);
    }
  };
  let closed = false;
  const process: ProcReceiveProcess = {
    interactive: options.interactive ?? true,
    write: async (data) => {
      input += decoder.decode(data);
      parse();
    },
    closeStdin: async () => {
      closed = true;
      wake?.();
    },
    stdout: {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          const next = answer.shift();
          if (next !== undefined) {
            yield encoder.encode(next);
            continue;
          }
          if (closed && answer.length === 0) return;
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        }
      },
    },
    wait: async () => options.exit ?? 0,
  };
  return { process, read };
}

describe("receive.procReceiveRefs (git's proc_receive_ref_matches)", () => {
  const cmd = (refName: string, oldOid: string, newOid: string) => ({ refName, oldOid, newOid });
  const X = "1".repeat(40);

  it("a prefix matches itself and what is below it, every kind of command", () => {
    const refs = ["refs/for/"].map(parseProcReceiveRef);
    expect(refs[0]?.prefix).toBe("refs/for");
    expect(procReceiveRefMatches(refs, cmd("refs/for/main/topic", ZERO, X))).toBe(true);
    expect(procReceiveRefMatches(refs, cmd("refs/for", X, ZERO))).toBe(true);
    expect(procReceiveRefMatches(refs, cmd("refs/forx", ZERO, X))).toBe(false);
  });

  it("modifiers pick creations, deletions, updates; `!` the refs outside", () => {
    const refs = ["m:refs/heads/main", "ad:refs/heads", "a!:refs/heads"].map(parseProcReceiveRef);
    expect(procReceiveRefMatches(refs, cmd("refs/heads/main", X, X))).toBe(true);
    expect(procReceiveRefMatches(refs, cmd("refs/heads/topic", X, X))).toBe(false);
    expect(procReceiveRefMatches(refs, cmd("refs/heads/topic", ZERO, X))).toBe(true);
    expect(procReceiveRefMatches(refs, cmd("refs/heads/topic", X, ZERO))).toBe(true);
    expect(procReceiveRefMatches(refs, cmd("refs/tags/v1", ZERO, X))).toBe(true);
    expect(procReceiveRefMatches(refs, cmd("refs/tags/v1", X, ZERO))).toBe(false);
  });
});

describe("receive-pack: the proc-receive hook", () => {
  it("takes the matching commands; its rewrites go out in report-status-v2", async () => {
    const { repo } = await serverRepo();
    const { client, commits } = await clientWithNewCommits(1);
    const n0 = commits[0] as string;
    const hook = scriptedHook([
      "ok refs/for/main/topic",
      "option refname refs/pull/1/head",
      `option new-oid ${n0}`,
      "ok refs/for/main/topic",
      "option refname refs/pull/2/head",
      "option forced-update",
    ]);
    let told: readonly ReceiveCommand[] = [];
    const run = await runReceivePack(
      repo,
      {
        commands: [`${ZERO} ${n0} refs/heads/n`, `${ZERO} ${n0} refs/for/main/topic`],
        caps: "report-status-v2 side-band-64k",
        pack: await fullPackOf(client, [n0]),
      },
      {
        procReceiveRefs: ["refs/for"],
        relayPostReceive: true,
        hooks: {
          procReceive: () => hook.process,
          postReceive: (commands) => {
            told = commands;
          },
        },
      },
    );
    expect(hook.read).toEqual(["version=1", "0000", `${ZERO} ${n0} refs/for/main/topic`, "0000"]);
    expect(run.report).toEqual([
      "unpack ok",
      "ok refs/heads/n",
      "ok refs/for/main/topic",
      "option refname refs/pull/1/head",
      `option new-oid ${n0}`,
      "ok refs/for/main/topic",
      "option refname refs/pull/2/head",
      "option forced-update",
    ]);
    // receive-pack updated only the other ref
    expect(await repo.refStore.get("refs/heads/n")).toBe(n0);
    expect(await repo.refStore.get("refs/for/main/topic")).toBeUndefined();
    expect(told.map((c) => `${c.refName} ${c.pushedRef ?? ""} ${c.report ?? ""}`)).toEqual([
      "refs/heads/n  ",
      "refs/pull/1/head refs/for/main/topic 0",
      "refs/pull/2/head refs/for/main/topic 1",
    ]);
  });

  it("report-status (v1) when the client asked for it: no option lines", async () => {
    const { repo } = await serverRepo();
    const { client, commits } = await clientWithNewCommits(1);
    const n0 = commits[0] as string;
    const hook = scriptedHook(["ok refs/for/x", "option refname refs/pull/1/head"]);
    const run = await runReceivePack(
      repo,
      {
        commands: [`${ZERO} ${n0} refs/for/x`],
        caps: "report-status side-band-64k",
        pack: await fullPackOf(client, [n0]),
      },
      { procReceiveRefs: ["refs/for"], hooks: { procReceive: () => hook.process } },
    );
    expect(run.report).toEqual(["unpack ok", "ok refs/for/x"]);
  });

  it("push options and atomic: the features of the version line", async () => {
    const { repo } = await serverRepo();
    const { client, commits } = await clientWithNewCommits(1);
    const n0 = commits[0] as string;
    const hook = scriptedHook(["ok refs/for/x"], { pushOptions: true });
    const run = await runReceivePack(
      repo,
      {
        commands: [`${ZERO} ${n0} refs/for/x`],
        caps: "report-status-v2 side-band-64k atomic push-options",
        pushOptions: ["a=1", "b"],
        pack: await fullPackOf(client, [n0]),
      },
      { procReceiveRefs: ["refs/for"], hooks: { procReceive: () => hook.process } },
    );
    expect(hook.read).toEqual([
      "version=1\\0atomic push-options",
      "0000",
      `${ZERO} ${n0} refs/for/x`,
      "0000",
      "a=1",
      "b",
      "0000",
    ]);
    expect(run.report).toEqual(["unpack ok", "ok refs/for/x"]);
  });

  it("git's errors: no hook, a version it does not speak, no report", async () => {
    const { repo } = await serverRepo();
    const { client, commits } = await clientWithNewCommits(1);
    const n0 = commits[0] as string;
    const request = async (hook?: ProcReceiveProcess) =>
      runReceivePack(
        repo,
        {
          commands: [`${ZERO} ${n0} refs/for/x`, `${ZERO} ${n0} refs/heads/y`],
          caps: "report-status-v2 side-band-64k",
          pack: await fullPackOf(client, [n0]),
        },
        {
          procReceiveRefs: ["refs/for"],
          hooks: hook ? { procReceive: () => hook } : {},
        },
      );
    const none = await request();
    expect(none.messages).toContain("error: cannot find hook 'proc-receive'");
    expect(none.report).toEqual([
      "unpack ok",
      "ng refs/for/x fail to run proc-receive hook",
      "ok refs/heads/y",
    ]);
    const v2 = await request(scriptedHook([], { version: 2 }).process);
    expect(v2.messages).toContain("error: proc-receive version '2' is not supported");
    expect(v2.report[1]).toBe("ng refs/for/x fail to run proc-receive hook");
    const silent = await request(scriptedHook([]).process);
    expect(silent.report[1]).toBe("ng refs/for/x proc-receive failed to report status");
    const unknown = await request(scriptedHook(["ok refs/for/x", "ok refs/for/z"]).process);
    expect(unknown.messages).toContain(
      "error: proc-receive reported status on unknown ref: refs/for/z",
    );
    // a report with errors fails the hook's run, but what it reported stands
    expect(unknown.report[1]).toBe("ok refs/for/x");
  });

  it("a hook that takes its whole stdin first (a runner without start)", async () => {
    const { repo } = await serverRepo();
    const { client, commits } = await clientWithNewCommits(1);
    const n0 = commits[0] as string;
    const hook = scriptedHook(["ng refs/for/x not now"], { interactive: false });
    const run = await runReceivePack(
      repo,
      {
        commands: [`${ZERO} ${n0} refs/for/x`],
        caps: "report-status-v2 side-band-64k",
        pack: await fullPackOf(client, [n0]),
      },
      { procReceiveRefs: ["refs/for"], hooks: { procReceive: () => hook.process } },
    );
    expect(run.report).toEqual(["unpack ok", "ng refs/for/x not now"]);
  });
});

describe("receive-pack: a proc-receive hook past hookTimeoutMs", () => {
  /** A hook that answers the version, reads the commands, then hangs until killed. */
  function hungHook(report: string[] = []): { process: ProcReceiveProcess; killed: () => number } {
    const hook = scriptedHook(report);
    let kills = 0;
    let stop: (() => void) | undefined;
    const stopped = new Promise<void>((resolve) => {
      stop = resolve;
    });
    const inner = hook.process.stdout[Symbol.asyncIterator]();
    let sent = 0;
    const process: ProcReceiveProcess = {
      ...hook.process,
      stdout: {
        async *[Symbol.asyncIterator]() {
          for (;;) {
            // the version and `report` (no flush after it): then nothing until killed
            const next = await Promise.race([inner.next(), stopped.then(() => undefined)]);
            if (!next || next.done) return;
            const text = decoder.decode(next.value);
            if (text === "0000" && sent > 0) {
              await stopped;
              return;
            }
            if (text === "0000") sent++;
            yield next.value;
          }
        },
      },
      wait: async () => {
        await stopped;
        return 143;
      },
      kill: () => {
        kills++;
        stop?.();
      },
    };
    return { process, killed: () => kills };
  }

  async function push(hook: ProcReceiveProcess, atomic: boolean, errors: unknown[]) {
    const { repo } = await serverRepo();
    const { client, commits } = await clientWithNewCommits(1);
    const n0 = commits[0] as string;
    return runReceivePack(
      repo,
      {
        commands: [
          `${ZERO} ${n0} refs/for/x`,
          `${ZERO} ${n0} refs/for/y`,
          `${ZERO} ${n0} refs/heads/z`,
        ],
        caps: `report-status-v2 side-band-64k${atomic ? " atomic" : ""}`,
        pack: await fullPackOf(client, [n0]),
      },
      {
        procReceiveRefs: ["refs/for"],
        hookTimeoutMs: 100,
        hooks: { procReceive: () => hook },
        logger: { error: (_m, e) => errors.push(e) },
      },
    );
  }

  it("kills the hook; the commands it did not report fail to run it", async () => {
    const hook = hungHook(["ok refs/for/x"]);
    const errors: unknown[] = [];
    const run = await push(hook.process, false, errors);
    expect(hook.killed()).toBe(1);
    expect(run.report).toEqual([
      "unpack ok",
      "ok refs/for/x",
      "ng refs/for/y fail to run proc-receive hook",
      "ok refs/heads/z",
    ]);
    expect(errors.some((e) => (e as Error)?.name === "HookTimeoutError")).toBe(true);
  });

  it("an atomic push fails whole", async () => {
    const hook = hungHook(["ok refs/for/x"]);
    const run = await push(hook.process, true, []);
    expect(hook.killed()).toBe(1);
    expect(run.report).toEqual([
      "unpack ok",
      "ng refs/for/x fail to run proc-receive hook",
      "ng refs/for/y fail to run proc-receive hook",
      "ng refs/heads/z fail to run proc-receive hook",
    ]);
  });
});

describe("receive-pack: an `ng` of the proc-receive hook", () => {
  it("keeps an empty reason (git's report: `ng <ref> `)", async () => {
    const { repo } = await serverRepo();
    const { client, commits } = await clientWithNewCommits(1);
    const n0 = commits[0] as string;
    const hook = scriptedHook(["ng refs/for/x ", "ng refs/for/y"]);
    const run = await runReceivePack(
      repo,
      {
        commands: [`${ZERO} ${n0} refs/for/x`, `${ZERO} ${n0} refs/for/y`],
        caps: "report-status-v2 side-band-64k",
        pack: await fullPackOf(client, [n0]),
      },
      { procReceiveRefs: ["refs/for"], hooks: { procReceive: () => hook.process } },
    );
    expect(run.report).toEqual(["unpack ok", "ng refs/for/x ", "ng refs/for/y failed"]);
  });
});
