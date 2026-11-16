/**
 * compilePosixRegex against glibc's regcomp/regexec (the matcher git uses for funcname
 * patterns on Linux): random extended and basic patterns (alternations, groups, every
 * repetition form, bracket expressions and classes, anchors, word boundaries, `\w`/`\s`,
 * back-references, case folding) on random subjects, compared on the overall match, the
 * first subexpression and whether the pattern compiles. A small C program is compiled as
 * the oracle; skipped without a C compiler or off glibc.
 *
 * `RX_SEEDS` sets the number of cases (default 3000), `RX_SHOW` how many mismatches to print.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { compilePosixRegex, PosixRegexError } from "../../src/regex/index.js";

const SEEDS = Number(process.env.RX_SEEDS ?? 3000);
const SHOW = Number(process.env.RX_SHOW ?? 5);

const ORACLE = String.raw`
#include <regex.h>
#include <stdio.h>
#include <string.h>
#include <locale.h>
#include <signal.h>
#include <unistd.h>
#include <sys/wait.h>
static int unhex(const char *h, char *out) {
  int n = strlen(h) / 2;
  for (int i = 0; i < n; i++) { unsigned v; sscanf(h + 2 * i, "%2x", &v); out[i] = (char)v; }
  out[n] = 0;
  return n;
}
static char fl[64], ph[400000], sh[400000], p[200000], s[200000];
int main(void) {
  setlocale(LC_ALL, "C");
  while (fgets(fl, sizeof fl, stdin) && fgets(ph, sizeof ph, stdin) && fgets(sh, sizeof sh, stdin)) {
    fl[strcspn(fl, "\n")] = 0; ph[strcspn(ph, "\n")] = 0; sh[strcspn(sh, "\n")] = 0;
    unhex(ph, p);
    int sl = unhex(sh, s);
    int cf = 0;
    if (strchr(fl, 'E')) cf |= REG_EXTENDED;
    if (strchr(fl, 'i')) cf |= REG_ICASE;
    /* each case in a child: a pattern glibc takes too long on (or crashes on) is a TIMEOUT */
    int fd[2];
    if (pipe(fd)) return 1;
    pid_t pid = fork();
    if (pid == 0) {
      close(fd[0]);
      alarm(2);
      char out[128];
      regex_t re;
      if (regcomp(&re, p, cf)) {
        snprintf(out, sizeof out, "ERR\n");
      } else {
        regmatch_t m[2];
        m[0].rm_so = 0; m[0].rm_eo = sl;
        if (regexec(&re, s, 2, m, REG_STARTEND)) snprintf(out, sizeof out, "NO\n");
        else snprintf(out, sizeof out, "%d %d %d %d\n", (int)m[0].rm_so, (int)m[0].rm_eo,
                      (int)m[1].rm_so, (int)m[1].rm_eo);
      }
      if (write(fd[1], out, strlen(out)) < 0) _exit(1);
      _exit(0);
    }
    close(fd[1]);
    char buf[128];
    ssize_t n = read(fd[0], buf, sizeof buf - 1);
    close(fd[0]);
    int st = 0;
    waitpid(pid, &st, 0);
    if (n <= 0 || !WIFEXITED(st) || WEXITSTATUS(st) != 0) fputs("TIMEOUT\n", stdout);
    else { buf[n] = 0; fputs(buf, stdout); }
    fflush(stdout);
  }
  return 0;
}
`;

let dir: string | undefined;
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** The compiled oracle, or undefined without a C compiler and glibc */
function oracle(): string | undefined {
  if (process.platform !== "linux") return undefined;
  dir = mkdtempSync(join(tmpdir(), "posix-regex-"));
  writeFileSync(join(dir, "rx.c"), ORACLE);
  const exe = join(dir, "rx");
  const cc = spawnSync("cc", ["-O1", "-o", exe, join(dir, "rx.c")], { encoding: "utf8" });
  if (cc.status !== 0) return undefined;
  const probe = spawnSync("ldd", ["--version"], { encoding: "utf8" });
  if (!/glibc|GNU libc/i.test(`${probe.stdout}${probe.stderr}`)) return undefined;
  return exe;
}
const exe = oracle();

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

const ATOMS = [
  "a",
  "b",
  "c",
  "ab",
  ".",
  "[ab]",
  "[^a]",
  "[a-c]",
  "\\w",
  "\\s",
  "\\W",
  "x",
  " ",
  "_",
  "[[:alpha:]]",
  "[]a]",
  "A",
  "B",
  "()",
  "[[:upper:]]",
  "[[:space:]]",
  "[[:alnum:]_]",
  "\\.",
  "\\(",
];
const OPS = ["", "", "", "*", "+", "?", "{2}", "{1,2}", "{,2}", "{0,1}", "{2,}", "**", "{0}"];
const SUBJECT = ["a", "b", "c", "x", " ", "_", "A", "B", "\xa0", "\t", "ab", "aa", "(", "."];

function generate(r: () => number, depth: number): string {
  const pick = <T>(a: readonly T[]) => a[Math.floor(r() * a.length)];
  const parts: string[] = [];
  const n = 1 + Math.floor(r() * 4);
  for (let i = 0; i < n; i++) {
    let atom: string;
    if (depth < 2 && r() < 0.4) {
      const k = 1 + Math.floor(r() * 3);
      const alts: string[] = [];
      for (let j = 0; j < k; j++) alts.push(r() < 0.1 ? "" : generate(r, depth + 1));
      atom = `(${alts.join("|")})`;
    } else atom = pick(ATOMS);
    parts.push(atom + pick(OPS));
  }
  return parts.join("");
}

describe.skipIf(!exe)("compilePosixRegex against glibc", () => {
  it(`matches glibc on ${SEEDS} random patterns`, () => {
    const r = prng(20261116);
    const cases: Array<{ flags: string; p: string; s: string }> = [];
    for (let i = 0; i < SEEDS; i++) {
      const extended = r() < 0.7;
      let p = generate(r, 0);
      if (!extended) p = p.replace(/[(){}|+?]/g, (c) => `\\${c}`);
      // anchors at the ends only: glibc mishandles some anchors inside repeated groups (it
      // finds "b*\\B" in "Ab" at 2, past a word boundary), which no driver pattern relies on
      const starts = ["^", "\\<", "\\b", "\\B"];
      const ends = ["$", "\\>", "\\b"];
      if (r() < 0.3) p = `${starts[Math.floor(r() * starts.length)]}${p}`;
      if (r() < 0.15) p = `${p}${ends[Math.floor(r() * ends.length)]}`;
      if (!extended && r() < 0.2) p = p.replace(/\\\)/, "\\)\\1");
      let s = "";
      const len = Math.floor(r() * 12);
      for (let j = 0; j < len; j++) s += SUBJECT[Math.floor(r() * SUBJECT.length)];
      cases.push({ flags: (extended ? "E" : "B") + (r() < 0.15 ? "i" : ""), p, s });
    }
    let input = "";
    for (const c of cases) {
      input += `${c.flags}\n${Buffer.from(c.p, "latin1").toString("hex")}\n${Buffer.from(c.s, "latin1").toString("hex")}\n`;
    }
    const res = spawnSync(exe as string, { input, maxBuffer: 1 << 28 });
    const theirs = res.stdout.toString().trim().split("\n");
    expect(theirs.length).toBe(cases.length);
    const mismatches: string[] = [];
    let matched = 0;
    let refused = 0;
    for (const [i, c] of cases.entries()) {
      if (theirs[i] === "TIMEOUT") continue;
      let ours: string;
      try {
        const re = compilePosixRegex(Buffer.from(c.p, "latin1"), {
          extended: c.flags.includes("E"),
          icase: c.flags.includes("i"),
        });
        const m = re.exec(Buffer.from(c.s, "latin1"), undefined, 2);
        ours = m ? `${m.start} ${m.end} ${m.groups[0]?.[0] ?? -1} ${m.groups[0]?.[1] ?? -1}` : "NO";
      } catch (e) {
        if (!(e instanceof PosixRegexError)) throw e;
        ours = "ERR";
      }
      if (theirs[i] === "ERR") refused++;
      else if (theirs[i] !== "NO") matched++;
      if (ours !== theirs[i]) {
        mismatches.push(
          `${c.flags} ${JSON.stringify(c.p)} ${JSON.stringify(c.s)} glibc ${theirs[i]} ours ${ours}`,
        );
      }
    }
    for (const m of mismatches.slice(0, SHOW)) console.log(m);
    expect(mismatches).toEqual([]);
    expect(matched).toBeGreaterThan(SEEDS / 5);
    expect(refused).toBeGreaterThan(0);
  }, 300_000);
});
