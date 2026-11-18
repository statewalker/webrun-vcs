/**
 * Test-only: objects crafted so their ids share a prefix with given ones, for abbreviations
 * that git must lengthen past `core.abbrev` (`find_unique_abbrev`).
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";

import { nativeGitEnv } from "./native-git-http-backend.js";

/** git's object id of `type` with `body` (SHA-1 of the header and the bytes). */
export const objectId = (type: string, body: Buffer) =>
  createHash("sha1").update(`${type} ${body.length}\0`).update(body).digest("hex");

/** The first `make(i)` whose id (as `type`) starts with `prefix`. */
export function craft(type: string, prefix: string, make: (i: number) => Buffer): Buffer {
  for (let i = 0; ; i++) {
    const body = make(i);
    if (objectId(type, body).startsWith(prefix)) return body;
  }
}

/**
 * A blob whose id shares exactly `digits` hex digits with `id`, written by native git into each of
 * `dirs` (twins get the same object); its id.
 */
export function collidingBlob(home: string, dirs: string[], id: string, digits: number): string {
  // exactly `digits` digits: the next one differs
  let body: Buffer = Buffer.alloc(0);
  for (let i = 0; ; i++) {
    body = craft("blob", id.slice(0, digits), (j) => Buffer.from(`collide ${id} ${i} ${j}\n`));
    if (objectId("blob", body)[digits] !== id[digits]) break;
  }
  let written = "";
  for (const dir of dirs) {
    written = execFileSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: dir,
      env: nativeGitEnv(home),
      input: body,
      encoding: "latin1",
    }).trim();
  }
  return written;
}
