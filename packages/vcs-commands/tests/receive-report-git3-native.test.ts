/**
 * git master's receive-report hook (t5412-receive-report-hook.sh), against the git 3.0 oracle
 * built from master (`$GIT3`): no release has the hook yet (2.56.1 does not). The pushes are
 * the twins of `receive-limits-native.test.ts` (`receiveTwins`) made with the oracle's git.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { git3Binary } from "./native-git3.js";
import {
  commitFiles,
  describeGit,
  git,
  hook,
  nativeOutcome,
  ourOutcome,
  ours,
  receiveTwins,
  source,
  stateOf,
} from "./receive-limits-native-support.js";

describeGit("receive-pack's receive-report hook, as git master", () => {
  const { twins, pushAll, setDaemonCompatibility } = receiveTwins();

  const git3 = git3Binary();
  describe.skipIf(!git3)("t5412-receive-report-hook.sh (git master)", () => {
    /** A hook body rewriting the report's pkt-lines with `transform` (a JS expression of `line`). */
    const rewrite = (transform: string, extra = "") =>
      `${extra}exec node -e '
const chunks = [];
process.stdin.on("data", (c) => chunks.push(c));
process.stdin.on("end", () => {
  const data = Buffer.concat(chunks);
  const out = [];
  for (let at = 0; at < data.length; ) {
    const n = parseInt(data.subarray(at, at + 4).toString(), 16);
    if (n === 0) { out.push("0000"); at += 4; continue; }
    let line = data.subarray(at + 4, at + n).toString();
    at += n;
    line = ${transform};
    out.push((line.length + 4).toString(16).padStart(4, "0") + line);
  }
  process.stdout.write(out.join(""));
});'`;

    const scenarios: { title: string; body?: string; raw?: boolean }[] = [
      { title: '"no report hook, push succeeds"' },
      { title: '"passthrough does not alter report"', body: "cat" },
      { title: '"non-zero exit reports as hook failed"', body: "exit 1" },
      { title: '"hook is invoked and receives report on stdin"', body: "tee raw", raw: true },
      {
        title: '"hook can modify the report sent to client"',
        body: rewrite('line.replace(/^ok /, "ng ")'),
      },
      {
        title: '"hook can modify the unpack status"',
        body: rewrite(
          'line.replace(/^unpack ok\\n$/, "unpack push failed due to server error\\n")',
        ),
      },
      {
        title: '"hook can report a custom failure message"',
        body: rewrite(
          'line.replace(/^ok (.*)\\n$/, "ng $1 service-x-is-down\\n")',
          'echo "push rejected: service X is down" >&2\n',
        ),
      },
      {
        title: '"hook stderr with zero exit status code"',
        body: 'echo "push rejected: service X is down" >&2\ntee raw',
        raw: true,
      },
      {
        title: '"hook stderr is relayed to client via sideband"',
        body: 'echo "hook-stderr-message" >&2\nexit 1',
      },
    ];

    for (const scenario of scenarios) {
      it(`t5412-receive-report-hook.sh: ${scenario.title}`, async () => {
        const src = source(2, 10);
        const t = twins(src, []);
        // t5412 pushes A first, then B with the hook in place
        git(src, "tag", "A", "HEAD~0");
        await pushAll(t, "HEAD:refs/heads/main", { binary: git3, compatibility: "2.56" });
        for (const name of ["n", "d", "o"] as const) {
          commitFiles(join(t[name], "src"), 2, 10, 1);
          if (scenario.body) hook(join(t[name], "dst"), "receive-report", scenario.body);
        }
        setDaemonCompatibility("2.56");
        try {
          const {
            native,
            served,
            ours: mine,
          } = await pushAll(t, "HEAD:refs/heads/main", {
            binary: git3,
            compatibility: "2.56",
          });
          const theirs = nativeOutcome(native);
          expect(nativeOutcome(served)).toEqual(theirs);
          expect(mine.result && ourOutcome(mine.result)).toEqual(theirs);
          const state = stateOf(join(t.n, "dst"));
          expect(stateOf(join(t.d, "dst")).refs).toEqual(state.refs);
          expect(stateOf(join(t.o, "dst")).refs).toEqual(state.refs);
          if (scenario.raw) {
            const raw = readFileSync(join(t.n, "dst", "raw"), "latin1");
            expect(readFileSync(join(t.d, "dst", "raw"), "latin1")).toBe(raw);
            expect(readFileSync(join(t.o, "dst", "raw"), "latin1")).toBe(raw);
          }
        } finally {
          setDaemonCompatibility(undefined);
        }
      });
    }

    it("git 2.43 runs no receive-report hook (ours under 2.43 compatibility neither)", async () => {
      const src = source(1, 10);
      const t = twins(src, [], (dst) => hook(dst, "receive-report", "exit 1"));
      const result = await (await ours(`${t.k}/o/src`, "2.43"))
        .push()
        .setRemote("../dst")
        .setRefSpecs("HEAD:refs/heads/main")
        .call();
      expect(result.remoteUpdates.every((u) => u.status === "ok")).toBe(true);
    });
  });
});
