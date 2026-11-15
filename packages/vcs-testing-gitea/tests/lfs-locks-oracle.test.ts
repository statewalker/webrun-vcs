import { LfsLockError, lfsLocks } from "@statewalker/vcs-transport-lfs";
import { afterAll, beforeAll, expect, it } from "vitest";
import { type GiteaServer, startGitea } from "../src/index.js";
import { describeGitea, tempDirs } from "./helpers.js";

/**
 * G5 — the Git LFS File Locking API: our `lfsLocks` client against Gitea's
 * (on whenever Gitea serves LFS, `[server] LFS_START_SERVER = true`). The
 * admin and a second user with write access lock, conflict, list with
 * pagination, verify and unlock; a lock someone else owns needs `force`.
 */
describeGitea("Gitea oracle · G5 Git LFS locks", () => {
  const tmp = tempDirs();
  let gitea: GiteaServer;
  const bob = { name: "bob", password: "bob-Secret-123" };

  async function rejection(p: Promise<unknown>): Promise<LfsLockError> {
    try {
      await p;
    } catch (e) {
      if (e instanceof LfsLockError) return e;
      throw e;
    }
    throw new Error("expected a rejection");
  }

  async function api(method: string, path: string, body: unknown, expected: number) {
    const r = await gitea.fetch(`${gitea.baseUrl}/api/v1${path}`, {
      method,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    if (r.status !== expected) throw new Error(`gitea: ${method} ${path}: ${r.status} ${text}`);
  }

  beforeAll(async () => {
    gitea = await startGitea();
    await api(
      "POST",
      "/admin/users",
      {
        username: bob.name,
        password: bob.password,
        email: "bob@example.com",
        must_change_password: false,
      },
      201,
    );
  });
  afterAll(async () => {
    await gitea?.stop();
    tmp.cleanup();
  });

  it("G5 create, conflict 409 with the existing lock, list and page, verify, unlock, force unlock", async () => {
    const repo = await gitea.createRepo("locks1");
    await api(
      "PUT",
      `/repos/${gitea.user}/${repo.name}/collaborators/${bob.name}`,
      { permission: "write" },
      204,
    );
    const admin = lfsLocks(repo.lfsUrl, fetch, {
      credentials: { username: gitea.user, password: gitea.password },
    });
    const asBob = lfsLocks(repo.lfsUrl, fetch, {
      credentials: { username: bob.name, password: bob.password },
    });
    const anonymous = lfsLocks(repo.lfsUrl);
    const ref = "refs/heads/main";

    // a private repository: no credentials, no locks
    expect((await rejection(anonymous.listLocks())).status).toBe(401);

    const mine = await admin.createLock("assets/logo.psd", ref);
    expect(mine).toMatchObject({ path: "assets/logo.psd", owner: { name: gitea.user } });
    expect(mine.id).toBeTruthy();
    expect(Number.isNaN(Date.parse(mine.locked_at))).toBe(false);

    const conflict = await rejection(asBob.createLock("assets/logo.psd", ref));
    expect(conflict.status).toBe(409);
    expect(conflict.lock?.id).toBe(mine.id);
    expect(conflict.lock?.owner?.name).toBe(gitea.user);

    const his = await asBob.createLock("b.bin", ref);
    const third = await admin.createLock("c.bin", ref);

    const all = (await admin.listLocks({ refspec: ref })).locks;
    expect(all.map((l) => l.path).sort()).toEqual(["assets/logo.psd", "b.bin", "c.bin"]);
    expect((await admin.listLocks({ path: "b.bin" })).locks.map((l) => l.id)).toEqual([his.id]);
    expect((await admin.listLocks({ id: mine.id })).locks.map((l) => l.path)).toEqual([
      "assets/logo.psd",
    ]);

    // Gitea's cursor is a page number, which our client passes back untouched.
    // Gitea 1.22 starts at cursor 0 and answers next_cursor "1", but its pages
    // are 1-based (0 and 1 are both the first page), so the first page comes
    // twice; allLocks drops what it has seen (by id), so each lock comes once
    const paged: string[] = [];
    for await (const l of admin.allLocks({ limit: 1 })) paged.push(l.path);
    expect(paged.sort()).toEqual(["assets/logo.psd", "b.bin", "c.bin"]);
    const first = await admin.listLocks({ limit: 2 });
    expect(first.locks).toHaveLength(2);
    expect(first.nextCursor).toBeTruthy();

    const verified = await admin.verifyLocks({ ref });
    expect(verified.ours.map((l) => l.path).sort()).toEqual(["assets/logo.psd", "c.bin"]);
    expect(verified.theirs.map((l) => l.path)).toEqual(["b.bin"]);
    const bobs = await asBob.verifyLocks({ ref });
    expect(bobs.ours.map((l) => l.id)).toEqual([his.id]);
    expect(bobs.theirs).toHaveLength(2);

    // someone else's lock: refused without force. The spec's answer is 403;
    // Gitea 1.22 answers 500 ("unable to delete lock": its "force flag is not
    // set" error is not mapped), so our client reports the status it got
    const refused = await rejection(asBob.unlock(mine.id, { ref }));
    expect([403, 500]).toContain(refused.status);
    expect((await admin.listLocks({ id: mine.id })).locks).toHaveLength(1);
    expect((await admin.unlock(third.id, { ref })).id).toBe(third.id);
    // force: Gitea lets a writer (here the admin) take another user's lock
    const forced = await admin.unlock(his.id, { force: true, ref });
    expect(forced.id).toBe(his.id);
    expect((await admin.unlock(mine.id)).path).toBe("assets/logo.psd");
    expect((await admin.listLocks()).locks).toEqual([]);
  });
});
