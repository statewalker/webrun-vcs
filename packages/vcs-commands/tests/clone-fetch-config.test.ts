/**
 * What `git clone` and `git fetch` leave behind besides objects and tracking refs: the
 * remote and upstream configuration a clone writes, `refs/remotes/<name>/HEAD`,
 * `FETCH_HEAD` (git's format and merge marks), the remote's configured refspecs and
 * `tagOpt` steering a later fetch, and shallow clones on the KV ref store.
 *
 * The expected values are what native git 2.43 writes for the same operations (see
 * clone-fetch-native-git.test.ts for the byte comparisons against native git itself).
 */

import { parseFetchHead } from "@statewalker/vcs-transport";
import type { WorkingCopy, WorkingCopyConfig } from "@statewalker/vcs-working-tree";
import { afterEach, describe, expect, it } from "vitest";

import { Git, RefUpdateStatus, TagOption } from "../src/index.js";
import { kvFactory } from "./backend-factories.js";
import { backends } from "./test-helper.js";
import {
  addFileAndCommit,
  createInitializedTestServer,
  createTestServer,
  createTestUrl,
} from "./transport-test-helper.js";

/** The URL as FETCH_HEAD shows it: no trailing `.git`. */
const SHOWN_URL = "http://localhost:3000/test";

/** The `remote.*` and `branch.*` entries of a plain config bag, sorted. */
function remoteAndBranchConfig(config: WorkingCopyConfig): Record<string, unknown> {
  const entries = Object.entries(config)
    .filter(([key]) => key.startsWith("remote.") || key.startsWith("branch."))
    .sort(([a], [b]) => a.localeCompare(b));
  return Object.fromEntries(entries);
}

describe.each([...backends, { name: "KV", factory: kvFactory }])(
  "clone and fetch configuration as git ($name backend)",
  ({ factory }) => {
    let cleanup: (() => Promise<void>) | undefined;
    const originalFetch = globalThis.fetch;

    afterEach(async () => {
      globalThis.fetch = originalFetch;
      if (cleanup) {
        await cleanup();
        cleanup = undefined;
      }
    });

    async function open(): Promise<{
      git: Git;
      workingCopy: WorkingCopy;
      config: WorkingCopyConfig;
    }> {
      const config: WorkingCopyConfig = {};
      const ctx = await factory({ config });
      const previous = cleanup;
      cleanup = async () => {
        await ctx.cleanup?.();
        await previous?.();
      };
      return { git: Git.fromWorkingCopy(ctx.workingCopy), workingCopy: ctx.workingCopy, config };
    }

    /** A remote with `main` (its HEAD), `feature`, and tags `v0` (older commit) and `v1` (tip). */
    async function remote() {
      const server = await createInitializedTestServer();
      const url = createTestUrl(server.baseUrl);
      const first = server.initialCommitId;
      await server.serverStores.refs.set("refs/tags/v0", first);
      const tip = await addFileAndCommit(server.serverStores, "a.txt", "a", "A");
      await server.serverStores.refs.set("refs/tags/v1", tip);
      await server.serverStores.refs.set("refs/heads/feature", first);
      globalThis.fetch = server.mockFetch;
      return { server, url, first, tip };
    }

    describe("CloneCommand configuration", () => {
      it("writes the remote, the upstream of the default branch, and refs/remotes/origin/HEAD", async () => {
        const { url } = await remote();
        const { git, workingCopy, config } = await open();

        await git.clone().setURI(url).call();

        expect(remoteAndBranchConfig(config)).toEqual({
          "branch.main.merge": "refs/heads/main",
          "branch.main.remote": "origin",
          "remote.origin.fetch": "+refs/heads/*:refs/remotes/origin/*",
          "remote.origin.url": url,
        });
        expect(await workingCopy.history.refs.get("refs/remotes/origin/HEAD")).toMatchObject({
          target: "refs/remotes/origin/main",
        });
        // the remote lists its tracking refs from the configuration
        const remotes = await git.remoteList().call();
        expect(remotes.map((r) => [r.name, r.urls])).toEqual([["origin", [url]]]);
      });

      it("--origin names the remote everywhere; --no-tags writes tagOpt", async () => {
        const { url } = await remote();
        const { git, workingCopy, config } = await open();

        await git.clone().setURI(url).setRemote("upstream").setNoTags().call();

        expect(remoteAndBranchConfig(config)).toEqual({
          "branch.main.merge": "refs/heads/main",
          "branch.main.remote": "upstream",
          "remote.upstream.fetch": "+refs/heads/*:refs/remotes/upstream/*",
          "remote.upstream.tagOpt": "--no-tags",
          "remote.upstream.url": url,
        });
        expect(await workingCopy.history.refs.get("refs/remotes/upstream/HEAD")).toMatchObject({
          target: "refs/remotes/upstream/main",
        });
        expect(await workingCopy.history.refs.get("refs/tags/v1")).toBeUndefined();
      });

      it("--branch clones every branch and sets up the named one", async () => {
        const { url } = await remote();
        const { git, workingCopy, config } = await open();

        const result = await git.clone().setURI(url).setBranch("feature").call();

        expect(result.defaultBranch).toBe("feature");
        expect(remoteAndBranchConfig(config)).toEqual({
          "branch.feature.merge": "refs/heads/feature",
          "branch.feature.remote": "origin",
          "remote.origin.fetch": "+refs/heads/*:refs/remotes/origin/*",
          "remote.origin.url": url,
        });
        expect(await workingCopy.history.refs.get("refs/remotes/origin/main")).toBeDefined();
        expect(await workingCopy.history.refs.get("refs/remotes/origin/HEAD")).toMatchObject({
          target: "refs/remotes/origin/main",
        });
        expect(await workingCopy.history.refs.get("HEAD")).toMatchObject({
          target: "refs/heads/feature",
        });
      });

      it("--single-branch --branch configures that branch alone, without refs/remotes/origin/HEAD", async () => {
        const { url } = await remote();
        const { git, workingCopy, config } = await open();

        await git.clone().setURI(url).setBranch("feature").setSingleBranch(true).call();

        expect(remoteAndBranchConfig(config)).toEqual({
          "branch.feature.merge": "refs/heads/feature",
          "branch.feature.remote": "origin",
          "remote.origin.fetch": "+refs/heads/feature:refs/remotes/origin/feature",
          "remote.origin.url": url,
        });
        expect(await workingCopy.history.refs.get("refs/remotes/origin/main")).toBeUndefined();
        expect(await workingCopy.history.refs.get("refs/remotes/origin/HEAD")).toBeUndefined();
      });

      it("--depth is single-branch on the remote HEAD's branch", async () => {
        const { url, tip } = await remote();
        const { git, workingCopy, config } = await open();

        await git.clone().setURI(url).setDepth(1).call();

        expect(remoteAndBranchConfig(config)).toEqual({
          "branch.main.merge": "refs/heads/main",
          "branch.main.remote": "origin",
          "remote.origin.fetch": "+refs/heads/main:refs/remotes/origin/main",
          "remote.origin.url": url,
        });
        expect(await workingCopy.history.refs.get("refs/remotes/origin/HEAD")).toMatchObject({
          target: "refs/remotes/origin/main",
        });
        expect(await workingCopy.history.refs.getShallow?.()).toEqual([tip]);
      });

      it("--single-branch --branch <tag> fetches the tag alone and detaches HEAD", async () => {
        const { url, tip } = await remote();
        const { git, workingCopy, config } = await open();

        await git.clone().setURI(url).setBranch("v1").setSingleBranch(true).call();

        expect(remoteAndBranchConfig(config)).toEqual({
          "remote.origin.fetch": "+refs/tags/v1:refs/tags/v1",
          "remote.origin.url": url,
        });
        expect(await workingCopy.history.refs.get("HEAD")).toMatchObject({ objectId: tip });
      });

      it("--bare writes only the URL; --mirror maps every ref and marks the mirror", async () => {
        const { url } = await remote();
        const bare = await open();
        await bare.git.clone().setURI(url).setBare(true).call();
        expect(remoteAndBranchConfig(bare.config)).toEqual({ "remote.origin.url": url });
        expect(await bare.workingCopy.history.refs.get("refs/remotes/origin/HEAD")).toBeUndefined();

        const mirror = await open();
        await mirror.git.clone().setURI(url).setMirror(true).call();
        expect(remoteAndBranchConfig(mirror.config)).toEqual({
          "remote.origin.fetch": "+refs/*:refs/*",
          "remote.origin.mirror": "true",
          // git 2.49+: --mirror implies --no-tags
          "remote.origin.tagOpt": "--no-tags",
          "remote.origin.url": url,
        });
      });

      it("an empty remote still gets the default refspec and the upstream of its unborn branch", async () => {
        const server = createTestServer();
        globalThis.fetch = server.mockFetch;
        const url = createTestUrl(server.baseUrl);
        const { git, config } = await open();

        const result = await git.clone().setURI(url).call();

        expect(result.fetchResult.isEmpty).toBe(true);
        const branch = result.defaultBranch;
        expect(remoteAndBranchConfig(config)).toEqual({
          [`branch.${branch}.merge`]: `refs/heads/${branch}`,
          [`branch.${branch}.remote`]: "origin",
          "remote.origin.fetch": "+refs/heads/*:refs/remotes/origin/*",
          "remote.origin.url": url,
        });
      });
    });

    describe("FetchCommand and FETCH_HEAD", () => {
      it("a configured fetch marks the upstream branch for merge and lists the others", async () => {
        const { url, server, tip } = await remote();
        const { git, workingCopy } = await open();
        await git.clone().setURI(url).call();
        const next = await addFileAndCommit(server.serverStores, "b.txt", "b", "B");
        await server.serverStores.refs.set("refs/heads/feature", next);

        // no refspec, no URL: the remote's configuration says what to fetch
        const result = await git.fetch().call();

        expect(result.trackingRefUpdates.map((u) => [u.localRef, u.status]).sort()).toEqual([
          ["refs/remotes/origin/feature", RefUpdateStatus.FAST_FORWARD],
          ["refs/remotes/origin/main", RefUpdateStatus.FAST_FORWARD],
        ]);
        expect(await workingCopy.checkout.readFetchHead?.()).toBe(
          `${next}\t\tbranch 'main' of ${SHOWN_URL}\n` +
            `${next}\tnot-for-merge\tbranch 'feature' of ${SHOWN_URL}\n`,
        );
        expect(tip).not.toBe(next);
      });

      it("explicit refspecs are all for merge; --tags lists the tags as not-for-merge", async () => {
        const { url, tip, first } = await remote();
        const { git, workingCopy } = await open();
        await git.clone().setURI(url).setNoCheckout(true).call();

        await git.fetch().setRefSpecs("refs/heads/feature").call();
        expect(await workingCopy.checkout.readFetchHead?.()).toBe(
          `${first}\t\tbranch 'feature' of ${SHOWN_URL}\n`,
        );

        await git.fetch().setTagOpt(TagOption.FETCH_TAGS).call();
        expect(await workingCopy.checkout.readFetchHead?.()).toBe(
          `${tip}\t\tbranch 'main' of ${SHOWN_URL}\n` +
            `${first}\tnot-for-merge\tbranch 'feature' of ${SHOWN_URL}\n` +
            `${first}\tnot-for-merge\ttag 'v0' of ${SHOWN_URL}\n` +
            `${tip}\tnot-for-merge\ttag 'v1' of ${SHOWN_URL}\n`,
        );
      });

      it("a fetch of a bare URL takes the remote HEAD into FETCH_HEAD only", async () => {
        const { url, tip } = await remote();
        const { git, workingCopy } = await open();

        const result = await git.fetch().setRemote(url).call();

        expect(result.trackingRefUpdates).toEqual([]);
        expect(await workingCopy.checkout.readFetchHead?.()).toBe(`${tip}\t\t${SHOWN_URL}\n`);
        const [line] = parseFetchHead((await workingCopy.checkout.readFetchHead?.()) ?? "");
        expect(line).toEqual({ oid: tip, notForMerge: false, description: SHOWN_URL });
      });

      it("auto-followed tags come after the branches: tags of fetched tips first, then older ones", async () => {
        const { url, tip, first, server } = await remote();
        // v1 tags the fetched tips; v0 an older commit, found in their history
        await server.serverStores.refs.set("refs/heads/feature", tip);
        const { git, workingCopy } = await open();
        await git.remoteAdd().setName("origin").setUri(url).call();

        await git.fetch().call();

        const lines = ((await workingCopy.checkout.readFetchHead?.()) ?? "").split("\n");
        // the branches in the order the remote lists them (git's servers sort; this one need not)
        expect(lines.slice(0, 2).sort()).toEqual([
          `${tip}\tnot-for-merge\tbranch 'feature' of ${SHOWN_URL}`,
          `${tip}\tnot-for-merge\tbranch 'main' of ${SHOWN_URL}`,
        ]);
        expect(lines.slice(2)).toEqual([
          `${tip}\tnot-for-merge\ttag 'v1' of ${SHOWN_URL}`,
          `${first}\tnot-for-merge\ttag 'v0' of ${SHOWN_URL}`,
          "",
        ]);
      });

      it("--append adds to FETCH_HEAD; --no-write-fetch-head and --dry-run leave it alone", async () => {
        const { url, tip, first } = await remote();
        const { git, workingCopy } = await open();
        const fetchHead = () => workingCopy.checkout.readFetchHead?.();

        await git.fetch().setRemote(url).call();
        await git.fetch().setRemote(url).setRefSpecs("feature").setAppend(true).call();
        const both = `${tip}\t\t${SHOWN_URL}\n${first}\t\tbranch 'feature' of ${SHOWN_URL}\n`;
        expect(await fetchHead()).toBe(both);

        await git.fetch().setRemote(url).setWriteFetchHead(false).call();
        await git.fetch().setRemote(url).setRefSpecs("feature").setDryRun(true).call();
        expect(await fetchHead()).toBe(both);
      });

      it("a branch.<name>.merge ref no refspec takes is fetched for FETCH_HEAD alone", async () => {
        const { url, tip, first } = await remote();
        const { git, workingCopy, config } = await open();
        await git.clone().setURI(url).setSingleBranch(true).call();
        config["branch.main.merge"] = "refs/heads/feature";

        await git.fetch().call();

        expect(await workingCopy.checkout.readFetchHead?.()).toBe(
          `${first}\t\tbranch 'feature' of ${SHOWN_URL}\n` +
            `${tip}\tnot-for-merge\tbranch 'main' of ${SHOWN_URL}\n`,
        );
        expect(await workingCopy.history.refs.get("refs/remotes/origin/feature")).toBeUndefined();
      });

      it("honours remote.<name>.tagOpt, and a remote without fetch lines fetches HEAD only", async () => {
        const { url, server } = await remote();
        const { git, workingCopy, config } = await open();
        await git.clone().setURI(url).setNoTags().call();
        const next = await addFileAndCommit(server.serverStores, "b.txt", "b", "B");
        await server.serverStores.refs.set("refs/tags/v2", next);

        await git.fetch().call();
        expect(await workingCopy.history.refs.get("refs/remotes/origin/main")).toMatchObject({
          objectId: next,
        });
        expect(await workingCopy.history.refs.get("refs/tags/v2")).toBeUndefined();

        delete config["remote.origin.fetch"];
        await addFileAndCommit(server.serverStores, "c.txt", "c", "C");
        const result = await git.fetch().call();
        expect(result.trackingRefUpdates).toEqual([]);
        expect(await workingCopy.checkout.readFetchHead?.()).toMatch(/^[0-9a-f]{40}\t\t/);
      });

      it("--prune keeps refs/remotes/origin/HEAD; remote set-head moves or deletes it", async () => {
        const { url, server } = await remote();
        const { git, workingCopy } = await open();
        await git.clone().setURI(url).call();
        await server.serverStores.refs.remove("refs/heads/feature");

        const result = await git.fetch().setRemoveDeletedRefs(true).call();

        expect(
          result.trackingRefUpdates
            .filter((u) => u.status === RefUpdateStatus.DELETED)
            .map((u) => u.localRef),
        ).toEqual(["refs/remotes/origin/feature"]);
        const refs = workingCopy.history.refs;
        expect(await refs.get("refs/remotes/origin/HEAD")).toMatchObject({
          target: "refs/remotes/origin/main",
        });

        await expect(
          git.remoteSetHead().setRemoteName("origin").setBranch("feature").call(),
        ).rejects.toThrow("Not a valid ref: refs/remotes/origin/feature");
        await git.fetch().setRefSpecs("+refs/heads/main:refs/remotes/origin/other").call();
        expect(await git.remoteSetHead().setRemoteName("origin").setBranch("other").call()).toBe(
          "refs/remotes/origin/other",
        );
        expect(await refs.get("refs/remotes/origin/HEAD")).toMatchObject({
          target: "refs/remotes/origin/other",
        });
        await git.remoteSetHead().setRemoteName("origin").setDelete(true).call();
        expect(await refs.get("refs/remotes/origin/HEAD")).toBeUndefined();
      });

      it("an upstream on another remote: the first exact refspec is not for merge", async () => {
        const { url, first } = await remote();
        const { git, workingCopy, config } = await open();
        await git.clone().setURI(url).setNoCheckout(true).call();
        config["remote.up2.url"] = url;
        config["remote.up2.fetch"] = "+refs/heads/feature:refs/remotes/up2/feature";

        await git.fetch().setRemote("up2").call();

        expect(await workingCopy.checkout.readFetchHead?.()).toBe(
          `${first}\tnot-for-merge\tbranch 'feature' of ${SHOWN_URL}\n`,
        );
      });

      it("a remote without fetch lines that is the upstream fetches the merge refs, for merge", async () => {
        const { url, first } = await remote();
        const { git, workingCopy, config } = await open();
        await git.clone().setURI(url).setNoCheckout(true).call();
        config["remote.up2.url"] = url;
        config["branch.main.remote"] = "up2";
        config["branch.main.merge"] = "refs/heads/feature";

        const result = await git.fetch().setRemote("up2").call();

        expect(result.trackingRefUpdates).toEqual([]);
        expect(await workingCopy.checkout.readFetchHead?.()).toBe(
          `${first}\t\tbranch 'feature' of ${SHOWN_URL}\n`,
        );
      });

      it("a failed fetch leaves FETCH_HEAD empty; a ref named twice is listed twice", async () => {
        const { url, tip } = await remote();
        const { git, workingCopy } = await open();
        await git.fetch().setRemote(url).call();
        expect(await workingCopy.checkout.readFetchHead?.()).not.toBe("");

        await expect(git.fetch().setRemote(url).setRefSpecs("nope").call()).rejects.toThrow();
        expect(await workingCopy.checkout.readFetchHead?.()).toBe("");

        await git.fetch().setRemote(url).setRefSpecs("main", "main").call();
        const line = `${tip}\t\tbranch 'main' of ${SHOWN_URL}\n`;
        expect(await workingCopy.checkout.readFetchHead?.()).toBe(`${line}${line}`);
      });

      it("auto-followed tags of one group are listed by name, whatever the remote's order", async () => {
        const { url, server, tip } = await remote();
        await server.serverStores.refs.remove("refs/tags/v0");
        await server.serverStores.refs.remove("refs/tags/v1");
        await server.serverStores.refs.set("refs/tags/t-b", tip);
        await server.serverStores.refs.set("refs/tags/t-a", tip);
        const { git, workingCopy } = await open();

        await git.fetch().setRemote(url).setRefSpecs("main:refs/remotes/x/main").call();

        expect(await workingCopy.checkout.readFetchHead?.()).toBe(
          `${tip}\t\tbranch 'main' of ${SHOWN_URL}\n` +
            `${tip}\tnot-for-merge\ttag 't-a' of ${SHOWN_URL}\n` +
            `${tip}\tnot-for-merge\ttag 't-b' of ${SHOWN_URL}\n`,
        );
      });
    });
  },
);

describe("shallow clone on the KV ref store", () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("records the shallow boundary, deepens and unshallows", async () => {
    const server = await createInitializedTestServer();
    const url = createTestUrl(server.baseUrl);
    await addFileAndCommit(server.serverStores, "a.txt", "a", "A");
    const tip = await addFileAndCommit(server.serverStores, "b.txt", "b", "B");
    globalThis.fetch = server.mockFetch;
    const { workingCopy } = await kvFactory();
    const git = Git.fromWorkingCopy(workingCopy);
    const refs = workingCopy.history.refs;

    const result = await git.clone().setURI(url).setDepth(1).call();

    expect(result.headCommit).toBe(tip);
    expect(await refs.getShallow?.()).toEqual([tip]);
    expect(await workingCopy.history.commits.has(server.initialCommitId)).toBe(false);

    await git.fetch().setUnshallow(true).call();
    expect(await refs.getShallow?.()).toEqual([]);
    expect(await workingCopy.history.commits.has(server.initialCommitId)).toBe(true);
  });
});
