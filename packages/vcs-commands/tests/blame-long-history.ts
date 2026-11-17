/**
 * A long, deterministic history for blame tests, written by native `git fast-import`: one
 * file of a few hundred lines edited by most commits (lines inserted, deleted, replaced and
 * blocks moved), renamed twice, merges of side branches that change the file's head, a small
 * file edited now and then, and unrelated files in other directories.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";

import { nativeGitEnv } from "./native-git-http-backend.js";

export interface LongHistory {
  /** The tip commit (also `refs/heads/main`) */
  tip: string;
  /** The long-lived file's path at the tip */
  path: string;
  /** The rarely edited file's path */
  notes: string;
  /** Commits written */
  commits: number;
}

export interface LongHistoryOptions {
  commits: number;
  lines: number;
  seed?: number;
}

function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WORDS = ["{", "}", "", "  return 0;", "int f(void)", "  if (x) {", "\tx++;", "foo bar"];
const AUTHORS = [
  ["Alice", "alice@example.com", "+0100"],
  ["Bob Builder", "bob@example.com", "-0700"],
  ["Carol", "carol@example.com", "+0530"],
];
/** Lines of the head kept for side branches: main's edits stay below it */
const HEAD = 12;

/** Writes the history into a new repository at `dir` (created). */
export function buildLongHistory(
  dir: string,
  home: string,
  options: LongHistoryOptions,
): LongHistory {
  const r = prng(options.seed ?? 1);
  mkdirSync(dir, { recursive: true });
  const env = nativeGitEnv(home);
  const git = (args: string[], input?: string) =>
    execFileSync("git", args, { cwd: dir, env, input, maxBuffer: 1 << 28 })
      .toString()
      .trim();
  git(["init", "-q", "-b", "main"]);

  let counter = 0;
  const line = () =>
    r() < 0.2
      ? WORDS[Math.floor(r() * WORDS.length)]
      : `line ${counter++} ${Math.floor(r() * 1e6)}`;
  const edit = (lines: string[], from: number) => {
    const out = [...lines];
    const ops = 1 + Math.floor(r() * 4);
    for (let k = 0; k < ops; k++) {
      const room = out.length - from;
      const at = from + Math.floor(r() * Math.max(1, room));
      const op = Math.floor(r() * 5);
      if (op === 0) out.splice(at, 0, ...Array.from({ length: 1 + Math.floor(r() * 5) }, line));
      else if (op === 1 && room > 4) out.splice(at, 1 + Math.floor(r() * 3));
      else if (op === 2 && at < out.length) out[at] = line();
      else if (op === 3 && room > 10) {
        const len = 1 + Math.floor(r() * 6);
        const block = out.splice(at, len);
        out.splice(from + Math.floor(r() * (out.length - from + 1)), 0, ...block);
      } else out.splice(at, 0, line());
    }
    return out;
  };

  let path = "src/main.c";
  const notes = "docs/notes.txt";
  let main = Array.from({ length: options.lines }, line);
  let noteLines = ["notes"];
  const others = Array.from({ length: 20 }, (_, i) => `other/d${i % 4}/f${i}.txt`);
  const text = (lines: string[]) => lines.map((l) => `${l}\n`).join("");
  const data = (s: string) => `data ${Buffer.byteLength(s)}\n${s}\n`;

  let out = "";
  let mark = 0;
  let date = 1_600_000_000;
  let tipMark = 0;
  const commit = (ref: string, parents: number[], files: string, message: string) => {
    const step = r();
    date += step < 0.1 ? 0 : 60 + Math.floor(r() * 7200);
    const [name, email, tz] = AUTHORS[Math.floor(r() * AUTHORS.length)];
    mark++;
    out += `commit ${ref}\nmark :${mark}\n`;
    out += `author ${name} <${email}> ${date - Math.floor(r() * 5000)} ${tz}\n`;
    out += `committer ${name} <${email}> ${date} ${tz}\n${data(message)}`;
    if (parents.length > 0) out += `from :${parents[0]}\n`;
    for (const p of parents.slice(1)) out += `merge :${p}\n`;
    out += `${files}\n`;
    return mark;
  };
  const put = (p: string, lines: string[]) => `M 100644 inline ${p}\n${data(text(lines))}`;

  let files = put(path, main) + put(notes, noteLines);
  for (const o of others) files += put(o, [`${o}`, line()]);
  tipMark = commit("refs/heads/main", [], files, "initial\n");
  let commits = 1;
  while (commits < options.commits) {
    const k = commits;
    if (k % 20 === 10 && commits + 2 <= options.commits) {
      // a side branch changing the head of the file, merged back
      const base = main;
      const sideHead = edit(base.slice(0, HEAD), 0);
      const side = commit(
        "refs/heads/side",
        [tipMark],
        put(path, [...sideHead, ...base.slice(HEAD)]),
        `side ${k}\n`,
      );
      main = edit(main, HEAD);
      const mainMark = commit("refs/heads/main", [tipMark], put(path, main), `commit ${k}\n`);
      main = [...sideHead, ...main.slice(HEAD)];
      tipMark = commit("refs/heads/main", [mainMark, side], put(path, main), `merge ${k}\n`);
      commits += 3;
      continue;
    }
    let change = "";
    const renames = path === "src/main.c" ? 0 : path === "lib/main.c" ? 1 : 2;
    if (renames < 2 && k >= Math.floor(((renames + 1) * options.commits) / 3)) {
      const to = path === "src/main.c" ? "lib/main.c" : "core/main.c";
      change += `D ${path}\n`;
      path = to;
      main = edit(main, HEAD);
      change += put(path, main);
    } else if (r() < 0.85) {
      main = edit(main, HEAD);
      change += put(path, main);
    }
    if (r() < 0.1) {
      noteLines = [...noteLines, `note ${k}`];
      change += put(notes, noteLines);
    }
    if (r() < 0.2) {
      const o = others[Math.floor(r() * others.length)];
      change += put(o, [o, line()]);
    }
    tipMark = commit("refs/heads/main", [tipMark], change, `commit ${k}\n`);
    commits++;
  }
  out += `reset refs/heads/main\nfrom :${tipMark}\n\n`;
  git(["fast-import", "--quiet"], out);
  const tip = git(["rev-parse", "refs/heads/main"]);
  return { tip, path, notes, commits };
}
