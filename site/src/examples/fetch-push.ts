import { Git, ResetMode } from "@statewalker/vcs-commands";
import {
  createMemoryHistoryWithOperations,
  type HistoryWithOperations,
} from "@statewalker/vcs-core";
import {
  createRepositoryFacade,
  createTransportRefStore,
  fetchOverDuplex,
  messagePortDuplex,
  pushOverDuplex,
  serveOverDuplex,
  serveOverPort,
} from "@statewalker/vcs-transport";
import {
  createMemoryCheckout,
  createMemoryGitStaging,
  createMemoryWorkingCopy,
  createMemoryWorktree,
} from "@statewalker/vcs-working-tree";
import type { Output } from "./output";

export default async function fetchPush(out: Output) {
  // Two repositories in one tab: "alice" has history, "bob" starts empty.
  const alice = await createRepository();
  const bob = await createRepository();

  for (const [name, text] of [
    ["README.md", "# Shared project\n"],
    ["plan.md", "1. sync with git's own protocol\n"],
  ]) {
    await alice.write(name, text);
    await alice.git.add().addFilepattern(name).call();
    await alice.git
      .commit()
      .setMessage(`Add ${name}`)
      .setAuthor("Alice", "alice@example.com")
      .call();
  }
  out.log(`alice: ${await count(alice.history, "refs/heads/main")} commits on main`);

  // A MessageChannel is the wire: one end could as well be a worker, another tab or a
  // WebRTC data channel. Alice serves git-upload-pack on it; Bob fetches through the other end.
  const fetchChannel = new MessageChannel();
  serveOverPort(fetchChannel.port2, (duplex) =>
    serveOverDuplex({
      duplex,
      repository: createRepositoryFacade({ history: alice.history }),
      refStore: createTransportRefStore(alice.history.refs),
      service: "git-upload-pack",
    }),
  );
  const fetched = await fetchOverDuplex({
    duplex: messagePortDuplex(fetchChannel.port1),
    repository: createRepositoryFacade({ history: bob.history }),
    refStore: createTransportRefStore(bob.history.refs),
    refspecs: ["+refs/heads/*:refs/remotes/alice/*"],
  });
  if (!fetched.success) throw new Error(`fetch failed: ${fetched.error}`);
  out.log("");
  out.log("$ git fetch alice   (git protocol over a MessagePort)");
  for (const [ref, id] of fetched.updatedRefs ?? [])
    out.log(`  ${ref} → ${String(id).slice(0, 7)}`);
  out.log(`  objects imported: ${fetched.objectsImported}`);

  // Bob now has every object: walk the history he received.
  const tip = (await bob.history.refs.resolve("refs/remotes/alice/main"))?.objectId;
  if (!tip) throw new Error("refs/remotes/alice/main is missing after the fetch");
  out.log("");
  out.log("$ git log --oneline alice/main   (in bob's repository)");
  for await (const id of bob.history.commits.walkAncestry(tip)) {
    const commit = await bob.history.commits.load(id);
    out.log(`  ${id.slice(0, 7)} ${commit?.message.trim()}`);
  }

  // Bob builds on what he fetched (git reset --hard alice/main), commits, and pushes the
  // result back to a new branch of Alice's: git-receive-pack on a second channel.
  await bob.git.reset().setRef("refs/remotes/alice/main").setMode(ResetMode.HARD).call();
  await bob.write("plan.md", "1. sync with git's own protocol\n2. push back\n");
  await bob.git.add().addFilepattern("plan.md").call();
  const bobs = await bob.git
    .commit()
    .setMessage("Extend the plan")
    .setAuthor("Bob", "bob@example.com")
    .call();

  const pushChannel = new MessageChannel();
  const receiving = new Promise<void>((resolve) => {
    serveOverPort(pushChannel.port2, (duplex) =>
      serveOverDuplex({
        duplex,
        repository: createRepositoryFacade({ history: alice.history }),
        refStore: createTransportRefStore(alice.history.refs),
        service: "git-receive-pack",
      }).finally(resolve),
    );
  });
  const pushed = await pushOverDuplex({
    duplex: messagePortDuplex(pushChannel.port1),
    repository: createRepositoryFacade({ history: bob.history }),
    refStore: createTransportRefStore(bob.history.refs),
    refspecs: ["refs/heads/main:refs/heads/from-bob"],
  });
  await receiving;
  if (!pushed.success) throw new Error(`push failed: ${pushed.error}`);
  out.log("");
  out.log("$ git push alice main:from-bob");
  for (const [ref, status] of pushed.refStatus ?? []) {
    out.log(`  ${ref}: ${status.success ? "ok" : `rejected (${status.error ?? status.status})`}`);
  }

  const received = (await alice.history.refs.resolve("refs/heads/from-bob"))?.objectId;
  const commit = received ? await alice.history.commits.load(received) : undefined;
  out.log(
    `  alice's from-bob → ${received?.slice(0, 7)} "${commit?.message.trim()}" by ${commit?.author.name}`,
  );
  if (received !== bobs.id) throw new Error("alice did not receive bob's commit");
}

async function createRepository() {
  const history: HistoryWithOperations = createMemoryHistoryWithOperations();
  await history.initialize();
  await history.refs.setSymbolic("HEAD", "refs/heads/main");
  const staging = createMemoryGitStaging();
  const checkout = createMemoryCheckout({ staging });
  const worktree = createMemoryWorktree({ blobs: history.blobs, trees: history.trees });
  const git = Git.fromWorkingCopy(createMemoryWorkingCopy({ history, checkout, worktree }));
  const write = (path: string, text: string) =>
    worktree.writeContent(path, new TextEncoder().encode(text));
  return { history, git, write };
}

async function count(history: HistoryWithOperations, ref: string) {
  const tip = (await history.refs.resolve(ref))?.objectId;
  let n = 0;
  if (tip) for await (const _ of history.commits.walkAncestry(tip)) n++;
  return n;
}
