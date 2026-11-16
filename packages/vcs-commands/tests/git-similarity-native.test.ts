/**
 * git's similarity estimate against native git: the same two blobs compared by our
 * estimateSimilarity and by `git diff-tree -M1%` (which prints git's score for any pair
 * above 1%), for text, CRLF, binary, long-line and unterminated contents.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  detectRenames,
  estimateSimilarity,
  GIT_MAX_SCORE,
  scorePercent,
  spanCounts,
} from "../src/rename/index.js";
import { nativeGitAvailable, nativeGitEnv } from "./native-git-http-backend.js";

const describeGit = nativeGitAvailable() && process.platform !== "win32" ? describe : describe.skip;

/** A deterministic pseudo-random generator (LCG). */
function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const encode = (s: string) => new TextEncoder().encode(s);

/** Pairs of contents with every kind of edit. */
function pairs(): Array<[string, Uint8Array, Uint8Array]> {
  const out: Array<[string, Uint8Array, Uint8Array]> = [];
  const rnd = random(7);
  const word = () => Math.floor(rnd() * 1e9).toString(36);
  const lines = (n: number) => Array.from({ length: n }, () => `${word()} ${word()}`);
  for (let k = 0; k < 24; k++) {
    const base = lines(5 + Math.floor(rnd() * 40));
    const edited = base.filter(() => rnd() > 0.2).map((l) => (rnd() > 0.85 ? `${l} x` : l));
    if (rnd() > 0.5) edited.push(...lines(Math.floor(rnd() * 8)));
    const eol = k % 3 === 0 ? "\r\n" : "\n";
    const tail = k % 4 === 1 ? "" : eol;
    out.push([`text-${k}`, encode(base.join(eol) + tail), encode(edited.join("\n") + tail)]);
  }
  // long lines (64-byte spans), no trailing newline, binary bytes, an empty side
  const long = "x".repeat(300) + "y".repeat(100);
  out.push(["long-lines", encode(`${long}\n${long}\n`), encode(`${long}\nshort\n`)]);
  out.push(["unterminated", encode("a\nb\nc\nd"), encode("a\nb\nc\nX")]);
  const bin = new Uint8Array(500).map((_, i) => (i * 7) % 256);
  const bin2 = bin.slice();
  bin2.set([1, 2, 3, 0, 13, 10], 200);
  out.push(["binary", bin, bin2]);
  out.push(["crlf-only", encode("a\r\nb\r\nc\r\n"), encode("a\nb\nc\n")]);
  out.push(["empty-dst", encode("a\nb\n"), new Uint8Array(0)]);
  out.push(["grown", encode("1\n2\n3\n"), encode("1\n2\n3\n4\n5\n6\n7\n")]);
  return out;
}

describeGit("git's similarity estimate (native git oracle)", () => {
  let root: string;
  const git = (args: string[], input?: string | Uint8Array) =>
    execFileSync("git", args, {
      cwd: root,
      env: nativeGitEnv(root),
      input,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "similarity-"));
    git(["init", "-q"]);
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  /** git's score (percent) for renaming `a` to `b`, or undefined when not a rename at 1%. */
  const nativeScore = (a: Uint8Array, b: Uint8Array) => {
    const ida = git(["hash-object", "-w", "--stdin"], a);
    const idb = git(["hash-object", "-w", "--stdin"], b);
    const t1 = git(["mktree"], `100644 blob ${ida}\told.txt\n`);
    const t2 = git(["mktree"], `100644 blob ${idb}\tnew.txt\n`);
    const raw = git(["diff-tree", "-r", "-M1%", "--raw", t1, t2]);
    const m = raw.match(/\tR(\d+)\t/) ?? raw.match(/ R(\d+)\t/);
    return m ? Number(m[1]) : undefined;
  };
  // git 2.43 left out a last span without a newline; current git (2.5x, CI) counts it
  const countLastSpan = () => {
    const [major, minor] = git(["--version"])
      .replace(/^git version /, "")
      .split(".")
      .map(Number);
    return major > 2 || (major === 2 && minor >= 50);
  };
  const ours = async (a: Uint8Array, b: Uint8Array) => {
    const options = { countLastSpan: countLastSpan() };
    const side = (bytes: Uint8Array) => ({
      mode: 0o100644,
      size: bytes.length,
      spans: async () => spanCounts(bytes, options),
    });
    const score = await estimateSimilarity(side(a), side(b), 600);
    return score >= 600 ? scorePercent(score) : undefined;
  };

  it("scores every pair as git does", async () => {
    const mismatches: string[] = [];
    for (const [name, a, b] of pairs()) {
      const expected = nativeScore(a, b);
      const actual = await ours(a, b);
      if (expected !== actual) mismatches.push(`${name}: git ${expected}, ours ${actual}`);
    }
    expect(mismatches).toEqual([]);
  });

  it("detectRenames pairs as git diff-tree -M does (exact, basename, best score)", async () => {
    const rnd = random(11);
    const text = (n: number) =>
      Array.from({ length: n }, () => `${Math.floor(rnd() * 1e9).toString(36)}\n`).join("");
    const a = text(30);
    const b = text(30);
    const c = text(10);
    const files: Record<string, string> = {
      "d/a.txt": a,
      "d/b.txt": b,
      "d/c.txt": c,
      "same.txt": "same\n",
      "dup1.txt": "dup\n",
    };
    const after: Record<string, string> = {
      "e/a.txt": `${a}extra\n`,
      "e/b2.txt": b.slice(0, Math.floor(b.length * 0.7)),
      "moved/same.txt": "same\n",
      "other.txt": "same\n",
      "dup2.txt": "dup\n",
      "e/c.txt": `${c.slice(0, 20)}changed a lot\nmore\nlines\nhere\n`,
    };
    const tree = (entries: Record<string, string>) => {
      const lines = Object.entries(entries).map(([path, content]) => {
        const id = git(["hash-object", "-w", "--stdin"], content);
        return `100644 blob ${id}\t${path}`;
      });
      git(["read-tree", "--empty"]);
      for (const line of lines) {
        const [meta, path] = line.split("\t");
        const [mode, , id] = meta.split(" ");
        git(["update-index", "--add", "--cacheinfo", `${mode},${id},${path}`]);
      }
      return git(["write-tree"]);
    };
    const t1 = tree(files);
    const t2 = tree(after);
    const raw = git(["diff-tree", "-r", "-M", "--raw", t1, t2]);
    const expected = raw
      .split("\n")
      .filter((l) => / R\d+\t/.test(l))
      .map((l) => {
        const [meta, from, to] = l.split("\t");
        return `${from} -> ${to} R${Number(meta.split(" ").pop()?.slice(1))}`;
      })
      .sort();
    const candidates = (entries: Record<string, string>) =>
      Object.entries(entries).map(([path, content]) => ({
        path,
        mode: 0o100644,
        id: git(["hash-object", "--stdin"], content),
      }));
    const contents = { ...files, ...after };
    const found = await detectRenames(candidates(files), candidates(after), {
      load: async (c) => encode(contents[c.path as keyof typeof contents]),
    });
    const actual = found.map((p) => `${p.from} -> ${p.to} R${scorePercent(p.score)}`).sort();
    expect(actual).toEqual(expected);
    expect(found.some((p) => p.score === GIT_MAX_SCORE)).toBe(true);
  });
});

describe("detectRenames options", () => {
  const content: Record<string, string> = {
    "a.txt": "1\n2\n3\n4\n5\n6\n",
    "b.txt": "1\n2\n3\n4\n5\n6\n7\n",
    "x.txt": "same\n",
    "y.txt": "same\n",
    e1: "",
    e2: "",
  };
  const c = (path: string, id = path) => ({ path, mode: 0o100644, id });
  const EMPTY = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";
  const load = async (x: { path: string }) => encode(content[x.path]);

  it("renameEmpty: false never pairs empty files (merge-ort); the default does (status)", async () => {
    const paired = await detectRenames([c("e1", EMPTY)], [c("e2", EMPTY)], { load });
    expect(paired.map((p) => p.to)).toEqual(["e2"]);
    const merge = await detectRenames([c("e1", EMPTY)], [c("e2", EMPTY)], {
      load,
      renameEmpty: false,
    });
    expect(merge).toEqual([]);
  });

  it("with sizes known, exact renames read nothing and compared contents are read once", async () => {
    const loads: string[] = [];
    const pairs = await detectRenames(
      [c("a.txt"), c("x.txt", "S")],
      [c("b.txt"), c("y.txt", "S")],
      {
        size: async (x) => content[x.path].length,
        load: async (x) => {
          loads.push(x.path);
          return encode(content[x.path]);
        },
      },
    );
    expect(pairs.map((p) => `${p.from}>${p.to}`).sort()).toEqual(["a.txt>b.txt", "x.txt>y.txt"]);
    expect(loads.sort()).toEqual(["a.txt", "b.txt"]);
  });

  it("a rename limit of 0 or less is 32767; a skipped detection reports the needed limit", async () => {
    const zero = await detectRenames([c("a.txt")], [c("b.txt")], { load, renameLimit: 0 });
    expect(zero).toHaveLength(1);
    let needed = 0;
    const none = await detectRenames([c("a.txt"), c("x.txt")], [c("b.txt"), c("y.txt", "Y")], {
      load,
      renameLimit: 1,
      onRenameLimit: (n) => {
        needed = n;
      },
    });
    expect(none).toEqual([]);
    expect(needed).toBe(2);
  });
});
