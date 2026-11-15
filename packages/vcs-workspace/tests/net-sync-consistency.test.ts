/**
 * syncWorkspace keeps a folder and its branch in step: a failing checkout leaves the branch
 * behind (never ahead of the folder), and an edit made during a sync is never overwritten.
 */

import type { FilesApi } from "@statewalker/webrun-files";
import { describe, expect, it } from "vitest";
import {
  openGitWorkspace,
  type SyncEvent,
  type SyncRemote,
  syncWorkspace,
} from "../src/net/index.js";
import {
  folderFiles,
  headOf,
  messageChannelRemote,
  serverRepo,
  workspace,
  writeFile,
} from "./net-helpers.js";

describe("syncWorkspace keeps the folder and its branch in step", () => {
  it("a folder write failing mid-checkout leaves the branch behind; the next sync finishes", async () => {
    const { server } = await serverRepo();
    const a = await workspace("Ann");
    for (let i = 0; i < 10; i++) await writeFile(a, `f${i}.txt`, `${i}\n`);
    await syncWorkspace(a, messageChannelRemote(server));

    const plain = await workspace("Bob", { "b.txt": "b\n" });
    let writes = 0;
    let armed = true;
    const folder: FilesApi = new Proxy(plain.folder, {
      get(target, prop, receiver) {
        if (prop === "write") {
          return async (
            path: string,
            content: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
          ) => {
            if (armed && ++writes > 4) throw new Error("disk full");
            return target.write(path, content);
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const b = await openGitWorkspace({
      folder,
      history: plain.history,
      identity: plain.identity,
      now: plain.now,
    });
    await expect(syncWorkspace(b, messageChannelRemote(server))).rejects.toThrow(/disk full/);
    // the branch did not move to the merge: it still names B's own commit
    const bHead = await headOf(b);
    expect((await b.history.commits.load(bHead as string))?.parents).toHaveLength(0);

    armed = false;
    await syncWorkspace(b, messageChannelRemote(server));
    await syncWorkspace(a, messageChannelRemote(server));
    const files = await folderFiles(a);
    expect(Object.keys(files)).toHaveLength(11);
    expect(files["b.txt"]).toBe("b\n");
    expect(await folderFiles(b)).toEqual(files);
    expect(await headOf(a)).toBe(await headOf(b));
  });

  it("an edit made during the sync is not overwritten: the round starts again", async () => {
    const { server } = await serverRepo();
    const a = await workspace("Ann", { "a.txt": "a\n" });
    const b = await workspace("Bob", { "b.txt": "b\n" });
    await syncWorkspace(a, messageChannelRemote(server));
    const base = messageChannelRemote(server);
    let edited = false;
    const editing: SyncRemote = {
      name: base.name,
      async fetch(o) {
        const result = await base.fetch(o);
        if (!edited) {
          edited = true;
          await writeFile(b, "b.txt", "typed during the sync\n");
        }
        return result;
      },
      push: (o) => base.push(o),
    };
    const events: SyncEvent[] = [];
    const result = await syncWorkspace(b, editing, { onEvent: (e) => events.push(e) });
    expect(result.attempts).toBe(2);
    expect(events.find((e) => e.type === "retry")).toMatchObject({
      reason: "the folder changed during the sync",
    });
    expect(await folderFiles(b)).toEqual({ "a.txt": "a\n", "b.txt": "typed during the sync\n" });
    await syncWorkspace(a, messageChannelRemote(server));
    expect(await folderFiles(a)).toEqual(await folderFiles(b));
  });
});
