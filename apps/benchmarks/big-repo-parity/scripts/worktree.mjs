#!/usr/bin/env node
// Porcelain parity on a real worktree: our commands (vcs-store-files over the Node FilesApi)
// against native git, both starting from the same source repository.
//
//   node worktree.mjs <work-dir> <source.git> [--steps clone,status,log,diff,checkout,commit,gc]
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

const commonRoot = (a, b) => {
  const x = a.split(sep);
  const y = b.split(sep);
  let i = 0;
  while (i < x.length && x[i] === y[i]) i++;
  return x.slice(0, i).join(sep) || sep;
};

import { pathToFileURL } from "node:url";

const VCS = resolve(import.meta.dirname, "../../../..");
const dist = (pkg, entry = "index.js") =>
  import(pathToFileURL(join(VCS, "packages", pkg, "dist", entry)).href);
const [workArg, sourceArg, ...rest] = process.argv.slice(2);
const STEPS = (
  rest.includes("--steps")
    ? rest[rest.indexOf("--steps") + 1]
    : "clone,status,log,diff,checkout,commit,gc"
).split(",");
const work = resolve(workArg);
const source = resolve(sourceArg);
mkdirSync(work, { recursive: true });

const ENV = {
  ...process.env,
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_AUTHOR_NAME: "Parity",
  GIT_AUTHOR_EMAIL: "parity@example.com",
  GIT_COMMITTER_NAME: "Parity",
  GIT_COMMITTER_EMAIL: "parity@example.com",
  GIT_AUTHOR_DATE: "1764000000 +0000",
  GIT_COMMITTER_DATE: "1764000000 +0000",
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "maintenance.auto",
  GIT_CONFIG_VALUE_0: "false",
  GIT_CONFIG_KEY_1: "gc.auto",
  GIT_CONFIG_VALUE_1: "0",
  GIT_EDITOR: ":",
  GIT_PAGER: "cat",
};
const git = (cwd, args, input) =>
  execFileSync("git", args, { cwd, env: ENV, input, maxBuffer: 2 ** 31 }).toString();
// byte-exact output as latin1 text: our callBytes and native stdout compare byte for byte
// (callText keeps non-UTF-8 bytes as U+DC80..U+DCFF, Node's UTF-8 decoding as U+FFFD)
const gitBytes = (cwd, args) =>
  execFileSync("git", args, { cwd, env: ENV, maxBuffer: 2 ** 31 }).toString("latin1");
const latin1 = (bytes) => Buffer.from(bytes).toString("latin1");
const gitRo = (cwd, args) => git(cwd, ["--no-optional-locks", ...args]);
const OURS = join(work, "ours");
const NATIVE = join(work, "native");

const results = [];
const mb = () => Math.round(process.memoryUsage().rss / 1048576);
async function step(name, fn) {
  if (!STEPS.includes(name)) return;
  const t0 = performance.now();
  let status = "ok";
  let detail = "";
  try {
    detail = (await fn()) ?? "";
  } catch (e) {
    status = "FAIL";
    detail = `${e?.name}: ${e?.message}`.slice(0, 1500);
    if (process.env.PARITY_STACK) console.error(e);
  }
  const ms = Math.round(performance.now() - t0);
  results.push({ backend: "fs-worktree", step: name, status, ms, rssMB: mb(), detail });
  console.log(
    `[fs-worktree] ${name.padEnd(9)} ${status.padEnd(4)} ${String(ms).padStart(8)} ms  rss ${mb()} MB  ${detail}`,
  );
}
const fail = (m) => {
  throw new Error(m);
};
const same = (label, ours, native) => {
  if (ours === native) return;
  const a = ours.split("\n");
  const b = native.split("\n");
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  fail(
    `${label} differs at line ${i + 1} (ours ${a.length} lines, native ${b.length}):\n  ours:   ${JSON.stringify(a[i])}\n  native: ${JSON.stringify(b[i])}`,
  );
};

const [{ Git }, { createGitFilesBackend, openGitLinkedWorktrees }, nodeFiles] = await Promise.all([
  dist("vcs-commands"),
  dist("vcs-store-files"),
  dist("vcs-utils-node", "files/index.js"),
]);
let g;
async function open() {
  // rooted above both the clone and the source, so the source path is reachable
  const root = commonRoot(OURS, source);
  const files = nodeFiles.createNodeFilesApi({ rootDir: root });
  const environment = nodeFiles.createNodeGitHostEnvironment({ env: ENV });
  const gitDir = `${relative(root, OURS)}/.git`;
  const { history } = await createGitFilesBackend({ files, gitDir, environment });
  const worktrees = await openGitLinkedWorktrees({ files, gitDir, history, environment });
  g = Git.fromWorkingCopy(await worktrees.openCurrent());
}

await step("clone", async () => {
  rmSync(OURS, { recursive: true, force: true });
  rmSync(NATIVE, { recursive: true, force: true });
  git(work, ["init", "-q", "-b", "master", OURS]);
  await open();
  await g.clone().setURI(source).setLocal(false).call();
  const t = performance.now();
  git(work, ["clone", "-q", "--no-local", source, NATIVE]);
  const nativeMs = Math.round(performance.now() - t);
  await open(); // the clone may have replaced the working copy's state
  same("for-each-ref", gitRo(OURS, ["for-each-ref"]), gitRo(NATIVE, ["for-each-ref"]));
  same("ls-files -s", gitRo(OURS, ["ls-files", "-s"]), gitRo(NATIVE, ["ls-files", "-s"]));
  same("native status in our clone", gitRo(OURS, ["status", "--porcelain"]), "");
  const fsck = spawnSync("git", ["fsck", "--no-dangling", "--no-progress"], {
    cwd: OURS,
    env: ENV,
  });
  if (fsck.status !== 0) fail(`native fsck of our clone: ${fsck.stderr.toString().slice(0, 500)}`);
  return `native clone ${nativeMs} ms; refs, index entries equal; native status clean; fsck ok`;
});

if (!g) await open();

await step("status", async () => {
  const ours0 = (await g.status().callText({ format: "porcelain" })).text;
  same("clean status", ours0, "");
  // the same edits in both worktrees
  for (const dir of [OURS, NATIVE]) {
    appendFileSync(join(dir, "Makefile"), "# parity edit\n");
    appendFileSync(join(dir, "README.md"), "parity edit\n");
    unlinkSync(join(dir, "COPYING"));
    writeFileSync(join(dir, "untracked-parity.txt"), "new\n");
    mkdirSync(join(dir, "newdir"), { recursive: true });
    writeFileSync(join(dir, "newdir/a.txt"), "a\n");
  }
  const ours = (await g.status().callText({ format: "porcelain" })).text;
  same("status --porcelain", ours, gitRo(NATIVE, ["status", "--porcelain"]));
  const oursLong = (await g.status().callText({ format: "long" })).text;
  same("status (long)", oursLong, gitRo(NATIVE, ["status"]));
  for (const dir of [OURS, NATIVE]) {
    git(dir, ["checkout", "-q", "--", "."]);
    git(dir, ["clean", "-qfd"]);
  }
  return "clean, porcelain and long status equal after edits";
});

await step("log", async () => {
  const out = [];
  const cases = [
    {
      args: ["log", "--oneline", "-n", "5000"],
      run: async () => latin1(await g.log().setMaxCount(5000).callBytes({ oneline: true })),
    },
    {
      args: ["log", "--stat", "-n", "200"],
      run: async () => latin1(await g.log().setMaxCount(200).callBytes({ stat: true })),
    },
    {
      args: ["log", "-p", "-n", "30", "--", "Makefile"],
      run: async () =>
        latin1(await g.log().setMaxCount(30).addPath("Makefile").callBytes({ patch: true })),
    },
  ];
  for (const c of cases) {
    const t = performance.now();
    const ours = await c.run();
    const oursMs = Math.round(performance.now() - t);
    const t2 = performance.now();
    const native = gitBytes(NATIVE, c.args);
    const nativeMs = Math.round(performance.now() - t2);
    same(`git ${c.args.join(" ")}`, ours, native);
    out.push(`${c.args.slice(1).join(" ")}: ${oursMs}/${nativeMs} ms`);
  }
  return `equal (ours/native) ${out.join("; ")}`;
});

await step("diff", async () => {
  const out = [];
  for (const [from, to] of [
    ["v2.40.0", "v2.41.0"],
    ["v2.0.0", "v2.30.0"],
  ]) {
    for (const format of ["stat", "patch"]) {
      const t = performance.now();
      const ours = latin1(await g.diff().setOldTree(from).setNewTree(to).callBytes(format));
      const oursMs = Math.round(performance.now() - t);
      const t2 = performance.now();
      const native = gitBytes(NATIVE, ["diff", format === "stat" ? "--stat" : "-p", from, to]);
      const nativeMs = Math.round(performance.now() - t2);
      same(`diff --${format} ${from} ${to}`, ours, native);
      out.push(`${from}..${to} ${format}: ${oursMs}/${nativeMs} ms`);
    }
  }
  return `equal (ours/native) ${out.join("; ")}`;
});

await step("checkout", async () => {
  const out = [];
  for (const target of ["v2.30.0", "v1.7.0", "master"]) {
    const t = performance.now();
    await g.checkout().setName(target).call();
    const ms = Math.round(performance.now() - t);
    same(`native status after checkout ${target}`, gitRo(OURS, ["status", "--porcelain"]), "");
    same(
      `HEAD after checkout ${target}`,
      gitRo(OURS, ["rev-parse", "HEAD"]),
      gitRo(NATIVE, ["rev-parse", `${target}^{commit}`]),
    );
    const tree = gitRo(OURS, ["write-tree"]).trim();
    same(
      `index tree after ${target}`,
      tree,
      gitRo(NATIVE, ["rev-parse", `${target}^{tree}`]).trim(),
    );
    out.push(`${target}: ${ms} ms`);
  }
  return `worktree, index, HEAD equal: ${out.join("; ")}`;
});

await step("commit", async () => {
  for (const dir of [OURS, NATIVE]) {
    appendFileSync(join(dir, "Makefile"), "# parity commit\n");
    writeFileSync(join(dir, "PARITY.txt"), "parity\n");
  }
  await g.add().addFilepattern("Makefile").addFilepattern("PARITY.txt").call();
  await g.commit().setMessage("parity commit\n").call();
  git(NATIVE, ["add", "Makefile", "PARITY.txt"]);
  git(NATIVE, ["commit", "-q", "-m", "parity commit"]);
  same("commit id", gitRo(OURS, ["rev-parse", "HEAD"]), gitRo(NATIVE, ["rev-parse", "HEAD"]));
  same(
    "reflog",
    gitRo(OURS, ["reflog", "-1", "--format=%gs"]),
    gitRo(NATIVE, ["reflog", "-1", "--format=%gs"]),
  );
  return `commit ${gitRo(OURS, ["rev-parse", "--short", "HEAD"]).trim()} identical to native`;
});

await step("gc", async () => {
  const count = (d) => gitRo(d, ["rev-list", "--objects", "--all", "--count"]).trim();
  const before = count(OURS);
  const t = performance.now();
  await g.gc().setPrune("now").call();
  const ms = Math.round(performance.now() - t);
  const t2 = performance.now();
  git(NATIVE, ["gc", "-q", "--prune=now"]);
  const nativeMs = Math.round(performance.now() - t2);
  const fsck = spawnSync("git", ["fsck", "--no-dangling", "--no-progress"], {
    cwd: OURS,
    env: ENV,
  });
  if (fsck.status !== 0) fail(`native fsck after our gc: ${fsck.stderr.toString().slice(0, 500)}`);
  same("objects after gc", count(OURS), before);
  same("objects vs native", count(OURS), count(NATIVE));
  const packs = (d) =>
    gitRo(d, ["count-objects", "-v"]).match(/packs: (\d+)/)[1] +
    " packs, " +
    gitRo(d, ["count-objects", "-v"]).match(/size-pack: (\d+)/)[1] +
    " KiB";
  return `ours ${ms} ms (${packs(OURS)}), native ${nativeMs} ms (${packs(NATIVE)}); fsck ok, ${before} objects kept`;
});

writeFileSync(join(work, "results-fs-worktree.json"), JSON.stringify(results, null, 2));
process.exit(results.some((r) => r.status !== "ok") ? 1 : 0);
