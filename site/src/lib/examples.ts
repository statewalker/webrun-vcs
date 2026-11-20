import { conceptHref } from "./concepts";

/** The live examples: each is a module of src/examples/ that the page shows and runs. */
export interface LiveExample {
  /** File name in src/examples/ (without .ts) and the page's slug. */
  name: string;
  label: string;
  title: string;
  /** One paragraph: what the example shows. */
  summary: string;
  /** What to look for in the output. */
  notes: string[];
  /** Packages the example imports. */
  packages: string[];
  /** The concept page sections that explain what the example shows. */
  concepts: { label: string; href: string }[];
  /** The repository's own example or demo covering the same ground. */
  related?: { label: string; path: string };
}

export const examples: LiveExample[] = [
  {
    name: "quick-start",
    label: "Quick start",
    title: "A repository in memory: add, commit, log",
    summary:
      "The porcelain API end to end: an in-memory history, index and worktree composed into a working copy, wrapped in the Git facade. Two commits, a status check, then git log.",
    notes: [
      "Commands are built with chainable setters and run once with call(), as in JGit.",
      "Commit ids change on every run: the commit records the current time.",
    ],
    packages: [
      "@statewalker/vcs-commands",
      "@statewalker/vcs-core",
      "@statewalker/vcs-working-tree",
    ],
    concepts: [
      { label: "Objects a commit is made of", href: conceptHref("object-model", "objects") },
      { label: "Refs and HEAD", href: conceptHref("branches-and-merging", "refs") },
      {
        label: "History, checkout and worktree",
        href: "/docs/architecture#history-checkout-worktree",
      },
    ],
    related: {
      label: "apps/examples/02-porcelain-commands",
      path: "apps/examples/02-porcelain-commands",
    },
  },
  {
    name: "branching-merging",
    label: "Branching & merging",
    title: "Branch, diverge, merge",
    summary:
      "git checkout -b, a commit on each side, then git merge: a three-way merge produces a merge commit with two parents, and the merged tree holds both changes.",
    notes: [
      "Switching back to main removes feature.md from the worktree: checkout updates files, not only HEAD.",
      "The log shows the merge commit's two parents.",
    ],
    packages: [
      "@statewalker/vcs-commands",
      "@statewalker/vcs-core",
      "@statewalker/vcs-working-tree",
    ],
    concepts: [
      { label: "Refs and HEAD", href: conceptHref("branches-and-merging", "refs") },
      {
        label: "Checkout rewrites the worktree",
        href: conceptHref("branches-and-merging", "checkout"),
      },
      {
        label: "Fast-forward and three-way merge",
        href: conceptHref("branches-and-merging", "merge"),
      },
    ],
    related: {
      label: "apps/examples/04-branching-merging",
      path: "apps/examples/04-branching-merging",
    },
  },
  {
    name: "object-model",
    label: "Object model",
    title: "Git's bytes, checked by the browser",
    summary:
      "A blob, a tree and a commit, serialized as Git stores loose objects. The page inflates each one with the browser's DecompressionStream and hashes it with Web Crypto: the SHA-1 equals the object id, and the blob's id is the one git hash-object prints.",
    notes: [
      "The checks use the browser's own zlib and SHA-1, not the library's.",
      "The fixed author time makes the tree and commit ids the same on every run.",
    ],
    packages: ["@statewalker/vcs-core"],
    concepts: [
      { label: "Blobs, trees, commits and tags", href: conceptHref("object-model", "objects") },
      { label: "The loose object format", href: conceptHref("object-model", "loose-format") },
      { label: "Why an id is the SHA-1 of the bytes", href: conceptHref("object-model", "ids") },
    ],
    related: { label: "apps/examples/03-object-model", path: "apps/examples/03-object-model" },
  },
  {
    name: "git-directory",
    label: "A real .git directory",
    title: "A .git directory over a FilesApi, ready for git",
    summary:
      "createGitFilesBackend writes Git's own layout (loose objects, refs, reflogs, the binary index) through a FilesApi, here an in-memory one. The example commits, tags, lists every file written, and offers the folder as a zip: unzip it and run git log, git status and git fsck.",
    notes: [
      "The same code runs on the Node filesystem (createNodeFilesApi) or in OPFS (webrun-files-browser).",
      "Download repository.zip after the run; native git reads it as it is.",
    ],
    packages: [
      "@statewalker/vcs-store-files",
      "@statewalker/vcs-commands",
      "@statewalker/webrun-files-mem",
    ],
    concepts: [
      { label: "Files go through a FilesApi", href: conceptHref("storage", "files-api") },
      { label: "The .git directory layout", href: conceptHref("storage", "git-layout") },
      { label: "Loose objects", href: conceptHref("object-model", "loose-format") },
    ],
    related: { label: "packages/vcs-store-files", path: "packages/vcs-store-files" },
  },
  {
    name: "fetch-push",
    label: "Fetch & push",
    title: "Git's protocol between two repositories in a tab",
    summary:
      "Two in-memory repositories exchange history over MessageChannels with the Git wire protocol: Bob fetches Alice's branch (upload-pack), commits on top and pushes back to a new branch of hers (receive-pack).",
    notes: [
      "A MessagePort stands in for any duplex: a worker, another tab, a WebRTC data channel.",
      "The same client and server state machines talk to Git HTTP servers.",
    ],
    packages: ["@statewalker/vcs-transport", "@statewalker/vcs-commands", "@statewalker/vcs-core"],
    concepts: [
      { label: "upload-pack and receive-pack", href: conceptHref("transport", "services") },
      { label: "Fetch negotiation", href: conceptHref("transport", "upload-pack") },
      { label: "Push commands and status", href: conceptHref("transport", "receive-pack") },
      { label: "State machines over a duplex", href: conceptHref("transport", "state-machines") },
    ],
    related: { label: "apps/demos/webrtc-p2p-sync", path: "apps/demos/webrtc-p2p-sync" },
  },
];
