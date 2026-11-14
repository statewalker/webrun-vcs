/**
 * Hand-built histories in the object kernel, for the listObjects and writePack tests.
 */
import { hexToBytes } from "@statewalker/vcs-utils/hash/utils";
import { createGitObjects } from "../../src/history/objects/git-objects.impl.js";
import type { GitObjects } from "../../src/history/objects/git-objects.js";
import { rawStorageStaging } from "../../src/storage/adapters/staging-blob-store.js";
import { MemoryRawStorage } from "../../src/storage/raw/memory-raw-storage.js";
import { concat } from "./pack-builder.js";

const enc = new TextEncoder();

export function memObjects(): GitObjects {
  return createGitObjects(rawStorageStaging(new MemoryRawStorage()));
}

export async function blob(objects: GitObjects, text: string | Uint8Array): Promise<string> {
  const data = typeof text === "string" ? enc.encode(text) : text;
  return objects.put("blob", data.length, [data]);
}

/** A tree from `[mode, name, id]` entries, sorted as git sorts them. */
export async function tree(objects: GitObjects, entries: [string, string, string][]) {
  const sorted = [...entries].sort((a, b) => {
    const ka = a[0] === "40000" ? `${a[1]}/` : a[1];
    const kb = b[0] === "40000" ? `${b[1]}/` : b[1];
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const data = concat(
    sorted.map(([mode, name, id]) => concat([enc.encode(`${mode} ${name}\0`), hexToBytes(id)])),
  );
  return objects.put("tree", data.length, [data]);
}

export async function commit(
  objects: GitObjects,
  treeId: string,
  parents: string[],
  time: number,
  msg = `c${time}`,
) {
  const text =
    `tree ${treeId}\n${parents.map((p) => `parent ${p}\n`).join("")}` +
    `author A <a@b> ${time} +0000\ncommitter A <a@b> ${time} +0000\n\n${msg}\n`;
  const data = enc.encode(text);
  return objects.put("commit", data.length, [data]);
}

export async function tag(objects: GitObjects, target: string, type: string, name: string) {
  const data = enc.encode(
    `object ${target}\ntype ${type}\ntag ${name}\ntagger A <a@b> 1 +0000\n\nmsg\n`,
  );
  return objects.put("tag", data.length, [data]);
}
