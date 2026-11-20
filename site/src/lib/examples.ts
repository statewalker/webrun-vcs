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
  /** The repository's own example or demo covering the same ground. */
  related?: { label: string; path: string };
  /** The pages (and sections) that explain what the example shows. */
  concepts: { label: string; href: string; why: string }[];
}

/** The explanation pages a playground session touches (src/pages/examples/playground.astro). */
export const playgroundConcepts: LiveExample["concepts"] = [
  {
    label: "History, checkout and worktree",
    href: "/docs/concepts#working-copy",
    why: "what Save file, Stage all and commit change: the worktree, the index, then the history",
  },
  {
    label: "Refs, HEAD and branches",
    href: "/docs/concepts#refs",
    why: "what Create & switch and Switch to it move",
  },
  {
    label: "Merging",
    href: "/docs/concepts#merge",
    why: "fast-forward or a three-way merge commit, and when a merge conflicts",
  },
  {
    label: "vcs-commands reference",
    href: "/docs/packages/vcs-commands",
    why: "every command the buttons call, and the many more they do not",
  },
];

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
    related: {
      label: "apps/examples/02-porcelain-commands",
      path: "apps/examples/02-porcelain-commands",
    },
    concepts: [
      {
        label: "Getting started: a first commit",
        href: "/docs#first-commit",
        why: "the same program, with how to install the packages",
      },
      {
        label: "History, checkout and worktree",
        href: "/docs/concepts#working-copy",
        why: "the three parts the example composes into a working copy, and what add and commit move between them",
      },
      {
        label: "The commands layer",
        href: "/docs/architecture#working-copy",
        why: "why the porcelain lives in its own package",
      },
      {
        label: "vcs-commands reference",
        href: "/docs/packages/vcs-commands",
        why: "every command of the Git facade",
      },
    ],
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
    related: {
      label: "apps/examples/04-branching-merging",
      path: "apps/examples/04-branching-merging",
    },
    concepts: [
      {
        label: "Refs, HEAD and branches",
        href: "/docs/concepts#refs",
        why: "a branch is a ref under refs/heads, and HEAD names the current one",
      },
      {
        label: "Merging",
        href: "/docs/concepts#merge",
        why: "the merge base, fast-forward versus a three-way merge, strategies and conflicts",
      },
      {
        label: "vcs-commands reference",
        href: "/docs/packages/vcs-commands",
        why: "checkout, merge and their options",
      },
    ],
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
    related: { label: "apps/examples/03-object-model", path: "apps/examples/03-object-model" },
    concepts: [
      {
        label: "The object model",
        href: "/docs/concepts#objects",
        why: "blobs, trees, commits and tags, and why an id names the content",
      },
      {
        label: "Loose objects and ids",
        href: "/docs/concepts#loose-objects",
        why: "the header, the zlib stream and the SHA-1 this example checks",
      },
      {
        label: "Pack files",
        href: "/docs/concepts#packs",
        why: "how the same objects are stored many at a time, as deltas",
      },
      {
        label: "vcs-core reference",
        href: "/docs/packages/vcs-core",
        why: "the object kernel, the typed stores and the pack functions",
      },
    ],
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
    related: { label: "packages/vcs-store-files", path: "packages/vcs-store-files" },
    concepts: [
      {
        label: "The .git directory",
        href: "/docs/concepts#git-directory",
        why: "what each file the example lists is for",
      },
      {
        label: "Storage is a set of small interfaces",
        href: "/docs/architecture#storage",
        why: "the other backends behind the same History",
      },
      {
        label: "Portable by construction",
        href: "/docs/architecture#portability",
        why: "why the same code writes to memory here and to a disk in Node",
      },
      {
        label: "vcs-store-files reference",
        href: "/docs/packages/vcs-store-files",
        why: "createGitFilesBackend, the ref store, gc and repack",
      },
    ],
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
    related: { label: "apps/demos/webrtc-p2p-sync", path: "apps/demos/webrtc-p2p-sync" },
    concepts: [
      {
        label: "The wire protocol",
        href: "/docs/concepts#transport",
        why: "upload-pack and receive-pack, pkt-lines, protocol v1 and v2",
      },
      {
        label: "Fetch negotiation",
        href: "/docs/concepts#negotiation",
        why: "how the two sides agree on which objects to send",
      },
      {
        label: "Refs, HEAD and branches",
        href: "/docs/concepts#refs",
        why: "the refspec that maps Alice's branches to refs/remotes/alice/*",
      },
      {
        label: "One transport for servers and peers",
        href: "/docs/architecture#transport",
        why: "why the same machines talk to a git host and to another tab",
      },
      {
        label: "vcs-transport reference",
        href: "/docs/packages/vcs-transport",
        why: "the HTTP and duplex operations and their results",
      },
    ],
  },
];
