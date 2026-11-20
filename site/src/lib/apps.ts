// The repository's runnable apps (docs/example-applications.md has the long descriptions).
export interface App {
  name: string;
  path: string;
  runtime: "node" | "browser";
  summary: string;
  /** The live example on this site that covers the same ground, if any. */
  live?: string;
}

export const tutorials: App[] = [
  {
    name: "01-quick-start",
    path: "apps/examples/01-quick-start",
    runtime: "node",
    summary:
      "The object-model loop in one file: a blob, a tree, two commits, a ref, the ancestry walk.",
    live: "object-model",
  },
  {
    name: "02-porcelain-commands",
    path: "apps/examples/02-porcelain-commands",
    runtime: "node",
    summary:
      "The whole workflow through the Git facade: commit, branch, checkout, merge, log, diff, status, tag, stash.",
    live: "quick-start",
  },
  {
    name: "03-object-model",
    path: "apps/examples/03-object-model",
    runtime: "node",
    summary: "Blobs, trees, commits and tags in depth, and content-addressed deduplication.",
    live: "object-model",
  },
  {
    name: "04-branching-merging",
    path: "apps/examples/04-branching-merging",
    runtime: "node",
    summary: "Branches, HEAD, fast-forward and three-way merges, strategies, conflicts, rebase.",
    live: "branching-merging",
  },
  {
    name: "05-history-operations",
    path: "apps/examples/05-history-operations",
    runtime: "node",
    summary: "Log traversal, ancestry, diffs between commits, blame, per-file history.",
  },
  {
    name: "06-internal-storage",
    path: "apps/examples/06-internal-storage",
    runtime: "node",
    summary: "Loose objects, pack files, garbage collection, deltas.",
  },
  {
    name: "07-staging-checkout",
    path: "apps/examples/07-staging-checkout",
    runtime: "node",
    summary:
      "The index: staging and unstaging, status, checking out files and branches, clean and reset.",
  },
  {
    name: "08-transport-basics",
    path: "apps/examples/08-transport-basics",
    runtime: "node",
    summary: "ls-remote, clone and fetch over smart HTTP against a public GitHub repository.",
  },
  {
    name: "09-repository-facade",
    path: "apps/examples/09-repository-facade",
    runtime: "node",
    summary:
      "A History behind a RepositoryFacade: packs round-tripped, served and fetched over a duplex.",
    live: "fetch-push",
  },
  {
    name: "10-custom-storage",
    path: "apps/examples/10-custom-storage",
    runtime: "node",
    summary: "Histories built from components: raw storage, object stores, explicit stores.",
  },
  {
    name: "11-delta-strategies",
    path: "apps/examples/11-delta-strategies",
    runtime: "node",
    summary:
      "Storage optimization with the DeltaApi: delta chains, batch repacking, delta primitives.",
  },
];

export const demos: App[] = [
  {
    name: "browser-vcs-app",
    path: "apps/demos/browser-vcs-app",
    runtime: "browser",
    summary:
      "A VCS application in a page with swappable storage: memory, or a folder through the File System Access API.",
  },
  {
    name: "offline-first-pwa",
    path: "apps/demos/offline-first-pwa",
    runtime: "browser",
    summary: "A Progressive Web App doing git operations entirely in the browser, offline.",
  },
  {
    name: "versioned-documents",
    path: "apps/demos/versioned-documents",
    runtime: "browser",
    summary: "DOCX and ODF files decomposed so their parts version and diff meaningfully.",
  },
  {
    name: "webrtc-p2p-sync",
    path: "apps/demos/webrtc-p2p-sync",
    runtime: "browser",
    summary: "Peer-to-peer git sync over WebRTC, peers connected by QR-code signaling.",
  },
  {
    name: "vcs-webrtc-sync",
    path: "apps/demos/vcs-webrtc-sync",
    runtime: "browser",
    summary: "Repositories synchronized between browsers over WebRTC.",
  },
  {
    name: "livekit-p2p-sync",
    path: "apps/demos/livekit-p2p-sync",
    runtime: "browser",
    summary: "Peer-to-peer synchronization between clients through LiveKit.",
  },
  {
    name: "http-server-scratch",
    path: "apps/demos/http-server-scratch",
    runtime: "node",
    summary:
      "A git HTTP server from scratch: serve, clone, push, each step verified with native git.",
  },
  {
    name: "git-workflow-complete",
    path: "apps/demos/git-workflow-complete",
    runtime: "node",
    summary:
      "An end-to-end workflow with porcelain commands only: init, add, commit, checkout, merge, log, diff, gc.",
  },
  {
    name: "git-cli-sandbox",
    path: "apps/demos/git-cli-sandbox",
    runtime: "node",
    summary:
      "A git CLI over the porcelain API and a file-backed store, fetch/pull/push over HTTP included.",
  },
  {
    name: "lfs-download-huggingface",
    path: "apps/demos/lfs-download-huggingface",
    runtime: "node",
    summary: "A real Hugging Face model file over standard Git LFS, SHA-256 verified.",
  },
  {
    name: "xet-transfer-huggingface",
    path: "apps/demos/xet-transfer-huggingface",
    runtime: "node",
    summary:
      "The webrun-chunks transfer: only missing content-defined chunks move between content stores.",
  },
];
