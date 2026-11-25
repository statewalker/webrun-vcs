/**
 * Test-only: rerere twins. The t4200 history built in two repositories (native git in one,
 * ours in the other), and rerere's state as both are compared: `MERGE_RR`'s bytes and every
 * file under `rr-cache/` (content, not times).
 */

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { gitOk, put } from "./merge-native-helpers.js";

/** t4200's `a1` at main. */
export const A1 = [
  "Some title",
  "==========",
  "Whether 'tis nobler in the mind to suffer",
  "The slings and arrows of outrageous fortune,",
  "Or to take arms against a sea of troubles,",
  "And by opposing end them? To die: to sleep;",
  "No more; and by a sleep to say we end",
  "The heart-ache and the thousand natural shocks",
  "That flesh is heir to, 'tis a consummation",
  "Devoutly to be wish'd.",
  "",
].join("\n");

/** What t4200's setup appends on `first`. */
export const A1_MORE = [
  "Some title",
  "==========",
  "To die, to sleep;",
  "To sleep: perchance to dream: ay, there's the rub;",
  "For in that sleep of death what dreams may come",
  "When we have shuffled off this mortal coil,",
  "Must give us pause: there's the respect",
  "That makes calamity of so long life;",
  "",
].join("\n");

/** t4200's `setup`: main, `first` (a1 extended), `second` (the same edited, `* END *`). */
export function buildT4200(home: string, dir: string, config: Record<string, string> = {}): void {
  mkdirSync(dir, { recursive: true });
  const run = (...args: string[]) => gitOk(home, dir, ...args);
  run("init", "-q", "-b", "main");
  for (const [key, value] of Object.entries(config)) run("config", key, value);
  put(dir, "a1", A1);
  run("add", "a1");
  run("commit", "-q", "-a", "-m", "initial");
  put(dir, "a1", A1 + A1_MORE);
  run("checkout", "-q", "-b", "first");
  run("commit", "-q", "-a", "-m", "first");
  run("checkout", "-q", "-b", "second", "main");
  put(
    dir,
    "a1",
    `${(A1 + A1_MORE).replace("To die, t", "To die! T").replace("Some title", "Some Title")}* END *\n`,
  );
  run("commit", "-q", "-a", "-m", "second");
}

/** rerere's files in `dir`'s git directory: `MERGE_RR` and `rr-cache/**` (content only). */
export function rerereState(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const gitDir = join(dir, ".git");
  const mergeRr = join(gitDir, "MERGE_RR");
  if (existsSync(mergeRr)) out.MERGE_RR = readFileSync(mergeRr, "latin1");
  const cache = join(gitDir, "rr-cache");
  if (!existsSync(cache)) return out;
  out["rr-cache/"] = "dir";
  for (const id of readdirSync(cache).sort()) {
    const sub = join(cache, id);
    if (!statSync(sub).isDirectory()) {
      out[`rr-cache/${id}`] = readFileSync(sub, "latin1");
      continue;
    }
    out[`rr-cache/${id}/`] = "dir";
    for (const name of readdirSync(sub).sort()) {
      out[`rr-cache/${id}/${name}`] = readFileSync(join(sub, name), "latin1");
    }
  }
  return out;
}

/** Copies `from`'s `rr-cache/` over `to`'s (what one side recorded, for the other to replay). */
export function copyRrCache(from: string, to: string): void {
  cpSync(join(from, ".git", "rr-cache"), join(to, ".git", "rr-cache"), { recursive: true });
}

/** The modification time of a file of `rr-cache/`, in seconds. */
export function rrMtime(dir: string, path: string): number {
  return Math.floor(statSync(join(dir, ".git", "rr-cache", path)).mtimeMs / 1000);
}
