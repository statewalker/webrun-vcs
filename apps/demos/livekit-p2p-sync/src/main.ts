/**
 * LiveKit P2P Git Sync Demo - Main Entry Point
 *
 * Demonstrates peer-to-peer repository synchronization using LiveKit rooms
 * for data transport. Unlike PeerJS (direct P2P), LiveKit uses a server
 * (SFU) that mediates connections, enabling multi-party sync.
 *
 * Architecture:
 * LiveKit Room → per-participant webrun ByteChannel (`byteChannelFromLiveKit`)
 *   → `emulateMux` → webrun `Duplex` → Git protocol FSM.
 *
 * Migrated off the retired `@statewalker/vcs-port-livekit`: the old
 * `RoomManager` wrapper is replaced by a `livekit-client` `Room` driven
 * directly, and `createLiveKitPort` (Room → MessagePort) is replaced by
 * `byteChannelFromLiveKit` (Room → webrun `ByteChannel`) multiplexed with
 * `emulateMux`.
 *
 * Prerequisites:
 *   livekit-server --dev    # Start local LiveKit server on ws://localhost:7880
 */

import { Git } from "@statewalker/vcs-commands";
import type { History, SerializationApi } from "@statewalker/vcs-core";
import { createMemoryHistory, DefaultSerializationApi, FileMode } from "@statewalker/vcs-core";
import {
  createMemoryGitStaging,
  MemoryCheckout,
  MemoryWorkingCopy,
  MemoryWorktree,
} from "@statewalker/vcs-working-tree";
import { emulateMux } from "@statewalker/webrun-streams";
import { byteChannelFromLiveKit } from "@statewalker/webrun-streams-livekit";
import { type RemoteParticipant, Room, RoomEvent } from "livekit-client";
import { generateDevToken } from "./services/dev-token.js";
import { createGitPeerSession, setupGitPeerServer } from "./services/index.js";

/** Per-participant multiplexer over the LiveKit data channel. */
type PeerMux = ReturnType<typeof emulateMux>;

// --- State ---

let room: Room | null = null;
let localIdentity = "";
let connected = false;
let history: History | null = null;
let serialization: SerializationApi | null = null;
let git: Git | null = null;

/** Active Git servers per participant identity */
const gitServers = new Map<string, () => void>();
/** Active per-participant muxes keyed by participant identity */
const participantMuxes = new Map<string, PeerMux>();

// --- Logging ---

function log(msg: string, level: "info" | "success" | "error" = "info"): void {
  const el = document.getElementById("log-output");
  if (!el) return;
  const line = document.createElement("div");
  line.className = `log-${level}`;
  const time = new Date().toLocaleTimeString();
  line.textContent = `[${time}] ${msg}`;
  el.appendChild(line);
  el.scrollTop = el.scrollHeight;
}

// --- Git Infrastructure ---

async function initializeGit(): Promise<void> {
  history = createMemoryHistory();
  await history.initialize();
  await history.refs.setSymbolic("HEAD", "refs/heads/main");

  const staging = createMemoryGitStaging();
  const checkout = new MemoryCheckout({
    staging,
    initialHead: { type: "symbolic", target: "refs/heads/main" },
  });
  const worktree = new MemoryWorktree({
    blobs: history.blobs,
    trees: history.trees,
  });
  const workingCopy = new MemoryWorkingCopy({ history, checkout, worktree });

  git = Git.fromWorkingCopy(workingCopy);
  serialization = new DefaultSerializationApi({ history });
}

// --- LiveKit Connection ---

async function connectToRoom(): Promise<void> {
  const urlInput = document.getElementById("lk-url") as HTMLInputElement;
  const roomInput = document.getElementById("lk-room") as HTMLInputElement;
  const identityInput = document.getElementById("lk-identity") as HTMLInputElement;
  const tokenInput = document.getElementById("lk-token") as HTMLInputElement;

  const url = urlInput.value.trim() || "ws://localhost:7880";
  const roomName = roomInput.value.trim() || "git-sync";
  const identity = identityInput.value.trim() || `user-${Math.random().toString(36).slice(2, 6)}`;

  // Use provided token or generate dev token
  let token = tokenInput.value.trim();
  if (!token) {
    log(`Generating dev token for identity="${identity}" room="${roomName}"`);
    token = await generateDevToken(identity, roomName);
  }

  updateConnectionStatus("connecting");
  log(`Connecting to ${url} as "${identity}" in room "${roomName}"...`);

  const instance = new Room();
  room = instance;

  instance.on(RoomEvent.ParticipantConnected, (p: RemoteParticipant) => {
    log(`Participant joined: ${p.identity}`, "success");
    setupParticipant(p.identity);
    updatePeerList();
  });

  instance.on(RoomEvent.ParticipantDisconnected, (p: RemoteParticipant) => {
    log(`Participant left: ${p.identity}`);
    cleanupParticipant(p.identity);
    updatePeerList();
  });

  instance.on(RoomEvent.Disconnected, () => {
    connected = false;
    log("Connection state: disconnected");
    updateConnectionStatus("disconnected");
  });

  try {
    await instance.connect(url, token);
    localIdentity = instance.localParticipant.identity;
    connected = true;
    identityInput.value = identity;
    updateConnectionStatus("connected");
    log(`Connected as "${localIdentity}"`, "success");

    // Set up muxes for existing participants
    for (const p of instance.remoteParticipants.values()) {
      setupParticipant(p.identity);
    }
    updatePeerList();
    updateButtons();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    log(`Connection failed: ${msg}`, "error");
    updateConnectionStatus("disconnected");
    room = null;
    connected = false;
  }
}

async function disconnectFromRoom(): Promise<void> {
  // Clean up all participant connections
  for (const identity of [...participantMuxes.keys()]) {
    cleanupParticipant(identity);
  }

  if (room) {
    await room.disconnect();
    room = null;
  }
  connected = false;

  updateConnectionStatus("disconnected");
  updatePeerList();
  updateButtons();
  log("Disconnected");
}

function setupParticipant(identity: string): void {
  if (!room || !history || !serialization) return;
  if (participantMuxes.has(identity)) return;

  // Two peers over one room data channel must pick opposite mux sides so
  // `emulateMux` stream-ids never collide; a deterministic identity compare
  // does that without any extra negotiation.
  const side = localIdentity < identity ? "initiator" : "responder";
  const channel = byteChannelFromLiveKit(room, identity);
  const mux = emulateMux(channel, { side });
  participantMuxes.set(identity, mux);

  // Start Git server for this participant
  const stopServer = setupGitPeerServer({
    serve: mux.serve,
    history,
    serialization,
    onPushReceived: () => {
      log(`Received push from ${identity}`, "success");
      refreshUI().catch((e) =>
        log(`UI refresh error: ${e instanceof Error ? e.message : String(e)}`, "error"),
      );
    },
    log: (msg) => log(`[server:${identity}] ${msg}`),
  });
  gitServers.set(identity, stopServer);
}

function cleanupParticipant(identity: string): void {
  const stopServer = gitServers.get(identity);
  if (stopServer) {
    stopServer();
    gitServers.delete(identity);
  }

  const mux = participantMuxes.get(identity);
  if (mux) {
    void mux.close();
    participantMuxes.delete(identity);
  }
}

// --- Git Operations ---

async function handleInit(): Promise<void> {
  if (!git || !history) {
    log("Git not initialized", "error");
    return;
  }

  try {
    const encoder = new TextEncoder();

    // Create initial file directly via history APIs
    const blob = await history.blobs.store([
      encoder.encode("# LiveKit P2P Sync Demo\n\nInitial repository.\n"),
    ]);
    const tree = await history.trees.store([
      { mode: FileMode.REGULAR_FILE, name: "README.md", id: blob },
    ]);

    const now = Math.floor(Date.now() / 1000);
    const author = {
      name: localIdentity || "User",
      email: "demo@example.com",
      timestamp: now,
      tzOffset: "+0000",
    };

    const commitId = await history.commits.store({
      tree,
      parents: [],
      author,
      committer: author,
      message: "Initial commit",
    });
    await history.refs.set("refs/heads/main", commitId);

    log(`Initialized repository: ${commitId.slice(0, 7)}`, "success");
    await refreshUI();
  } catch (error) {
    log(`Init failed: ${error instanceof Error ? error.message : String(error)}`, "error");
  }
}

async function handleAddFile(): Promise<void> {
  if (!history) return;

  const fileName = `file-${Date.now() % 10000}.txt`;
  const content = `Created by ${localIdentity || "user"} at ${new Date().toISOString()}\n`;
  const encoder = new TextEncoder();

  try {
    // Get current tree
    const mainRef = await history.refs.resolve("refs/heads/main");
    if (!mainRef?.objectId) {
      log("No commits yet — init first", "error");
      return;
    }

    const parentCommit = await history.commits.load(mainRef.objectId);
    if (!parentCommit) return;

    // Load existing tree entries
    const existingEntries = [];
    const treeEntries = await history.trees.load(parentCommit.tree);
    if (treeEntries) {
      for await (const entry of treeEntries) {
        existingEntries.push(entry);
      }
    }

    // Add new file
    const blob = await history.blobs.store([encoder.encode(content)]);
    existingEntries.push({ mode: FileMode.REGULAR_FILE, name: fileName, id: blob });

    const tree = await history.trees.store(existingEntries);

    const now = Math.floor(Date.now() / 1000);
    const author = {
      name: localIdentity || "User",
      email: "demo@example.com",
      timestamp: now,
      tzOffset: "+0000",
    };

    const commitId = await history.commits.store({
      tree,
      parents: [mainRef.objectId],
      author,
      committer: author,
      message: `Add ${fileName}`,
    });
    await history.refs.set("refs/heads/main", commitId);

    log(`Added ${fileName}: ${commitId.slice(0, 7)}`, "success");
    await refreshUI();
  } catch (error) {
    log(`Add file failed: ${error instanceof Error ? error.message : String(error)}`, "error");
  }
}

async function handleSync(identity: string): Promise<void> {
  if (!history || !serialization) return;

  const mux = participantMuxes.get(identity);
  if (!mux) {
    log(`No connection to ${identity}`, "error");
    return;
  }

  log(`Starting sync with ${identity}...`);

  const session = createGitPeerSession({
    call: mux.call,
    history,
    serialization,
    log: (msg) => log(`[sync:${identity}] ${msg}`),
  });

  // Remember local main before fetch
  const localMainBefore = await history.refs.resolve("refs/heads/main");

  // Fetch from peer → refs/remotes/peer/*
  const fetchResult = await session.fetch();
  if (fetchResult.ok && fetchResult.objectsReceived > 0) {
    log(`Fetched ${fetchResult.objectsReceived} objects from ${identity}`, "success");
  } else if (fetchResult.ok) {
    log(`Already up to date with ${identity}`);
  } else {
    log(`Fetch failed: ${fetchResult.error}`, "error");
  }

  // Merge fetched refs into local main (fast-forward or create merge commit)
  if (fetchResult.ok) {
    const remotePeerMain = fetchResult.refs.get("refs/remotes/peer/main");
    if (remotePeerMain) {
      if (!localMainBefore?.objectId) {
        // No local commits — fast-forward to remote
        await history.refs.set("refs/heads/main", remotePeerMain);
        log(`Fast-forwarded main to ${remotePeerMain.slice(0, 7)}`, "success");
      } else if (localMainBefore.objectId !== remotePeerMain) {
        // Check if remote is ancestor of local (already up to date)
        const isRemoteAncestor = await isAncestorOf(
          history,
          remotePeerMain,
          localMainBefore.objectId,
        );
        if (isRemoteAncestor) {
          log("Remote is already included in local history");
        } else {
          // Check if local is ancestor of remote (can fast-forward)
          const isLocalAncestor = await isAncestorOf(
            history,
            localMainBefore.objectId,
            remotePeerMain,
          );
          if (isLocalAncestor) {
            await history.refs.set("refs/heads/main", remotePeerMain);
            log(`Fast-forwarded main to ${remotePeerMain.slice(0, 7)}`, "success");
          } else {
            // Diverged — create a merge commit combining both trees
            const mergeCommitId = await createMergeCommit(
              history,
              localMainBefore.objectId,
              remotePeerMain,
              identity,
            );
            if (mergeCommitId) {
              await history.refs.set("refs/heads/main", mergeCommitId);
              log(`Merged remote into main: ${mergeCommitId.slice(0, 7)}`, "success");
            }
          }
        }
      }
    }
  }

  // Push to peer
  const pushResult = await session.push();
  if (pushResult.ok) {
    log(`Pushed to ${identity}`, "success");
  } else {
    log(`Push failed: ${pushResult.error}`, "error");
  }

  await refreshUI();
}

/**
 * Check if `ancestor` is an ancestor of `descendant` by walking parents.
 */
async function isAncestorOf(h: History, ancestor: string, descendant: string): Promise<boolean> {
  const visited = new Set<string>();
  const queue = [descendant];

  while (queue.length > 0) {
    const oid = queue.shift();
    if (!oid) continue;
    if (oid === ancestor) return true;
    if (visited.has(oid)) continue;
    visited.add(oid);

    const commit = await h.commits.load(oid);
    if (commit) {
      for (const parent of commit.parents) {
        queue.push(parent);
      }
    }
  }
  return false;
}

/**
 * Create a simple merge commit that takes the remote tree
 * (picks the "newer" side for simplicity in the demo).
 */
async function createMergeCommit(
  h: History,
  localOid: string,
  remoteOid: string,
  peerIdentity: string,
): Promise<string | null> {
  try {
    // Use the remote tree as the merge result (simple "theirs" strategy for the demo)
    const remoteCommit = await h.commits.load(remoteOid);
    if (!remoteCommit) return null;

    const now = Math.floor(Date.now() / 1000);
    const author = {
      name: localIdentity || "User",
      email: "demo@example.com",
      timestamp: now,
      tzOffset: "+0000",
    };

    return await h.commits.store({
      tree: remoteCommit.tree,
      parents: [localOid, remoteOid],
      author,
      committer: author,
      message: `Merge from ${peerIdentity}`,
    });
  } catch (error) {
    log(`Merge failed: ${error instanceof Error ? error.message : String(error)}`, "error");
    return null;
  }
}

// --- UI Updates ---

function updateConnectionStatus(state: "disconnected" | "connecting" | "connected"): void {
  const el = document.getElementById("connection-status");
  if (!el) return;
  el.className = `status status-${state}`;
  el.textContent = state.charAt(0).toUpperCase() + state.slice(1);
}

function updateButtons(): void {
  const hasCommits = history !== null;

  (document.getElementById("btn-connect") as HTMLButtonElement).disabled = connected;
  (document.getElementById("btn-disconnect") as HTMLButtonElement).disabled = !connected;
  (document.getElementById("btn-add-file") as HTMLButtonElement).disabled = !hasCommits;
}

function updatePeerList(): void {
  const list = document.getElementById("peer-list");
  if (!list) return;

  const participants = room ? [...room.remoteParticipants.values()] : [];

  if (participants.length === 0) {
    list.innerHTML = '<li class="empty">No participants yet</li>';
    return;
  }

  list.innerHTML = "";
  for (const p of participants) {
    const li = document.createElement("li");
    li.innerHTML = `
      <span><span class="peer-dot"></span>${p.identity}</span>
      <button class="secondary" data-sync="${p.identity}">Sync</button>
    `;
    list.appendChild(li);
  }

  // Bind sync buttons
  for (const btn of list.querySelectorAll<HTMLButtonElement>("[data-sync]")) {
    btn.addEventListener("click", () => {
      const identity = btn.dataset.sync;
      if (identity) handleSync(identity);
    });
  }
}

async function updateFileList(): Promise<void> {
  const list = document.getElementById("file-list");
  if (!list || !history) {
    if (list) list.innerHTML = '<li class="empty">Repository not initialized</li>';
    return;
  }

  const mainRef = await history.refs.resolve("refs/heads/main");
  if (!mainRef?.objectId) {
    list.innerHTML = '<li class="empty">No commits yet</li>';
    return;
  }

  const commit = await history.commits.load(mainRef.objectId);
  if (!commit) return;

  list.innerHTML = "";
  const entries = await history.trees.load(commit.tree);
  if (entries) {
    for await (const entry of entries) {
      const li = document.createElement("li");
      li.textContent = entry.name;
      list.appendChild(li);
    }
  }
}

async function updateCommitList(): Promise<void> {
  const list = document.getElementById("commit-list");
  if (!list || !history) return;

  const mainRef = await history.refs.resolve("refs/heads/main");
  if (!mainRef?.objectId) {
    list.innerHTML = '<li class="empty">No commits</li>';
    return;
  }

  list.innerHTML = "";
  let oid: string | undefined = mainRef.objectId;
  let count = 0;

  while (oid && count < 20) {
    const commit = await history.commits.load(oid);
    if (!commit) break;

    const li = document.createElement("li");
    const time = new Date(commit.author.timestamp * 1000).toLocaleTimeString();
    li.innerHTML = `
      <span class="commit-hash">${oid.slice(0, 7)}</span>
      <span class="commit-msg">${commit.message}</span>
      <span class="commit-time">${commit.author.name} at ${time}</span>
    `;
    list.appendChild(li);

    oid = commit.parents[0];
    count++;
  }
}

async function refreshUI(): Promise<void> {
  updateButtons();
  try {
    await updateFileList();
  } catch (error) {
    log(
      `File list update error: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
  }
  try {
    await updateCommitList();
  } catch (error) {
    log(
      `Commit list update error: ${error instanceof Error ? error.message : String(error)}`,
      "error",
    );
  }
}

// --- Bootstrap ---

async function initializeApp(): Promise<void> {
  await initializeGit();

  // Wire up buttons
  document.getElementById("btn-connect")?.addEventListener("click", connectToRoom);
  document.getElementById("btn-disconnect")?.addEventListener("click", disconnectFromRoom);
  document.getElementById("btn-init")?.addEventListener("click", handleInit);
  document.getElementById("btn-add-file")?.addEventListener("click", handleAddFile);

  // Generate a random identity
  const identityInput = document.getElementById("lk-identity") as HTMLInputElement;
  if (identityInput && !identityInput.value) {
    identityInput.value = `user-${Math.random().toString(36).slice(2, 6)}`;
  }

  updateButtons();
  log("Application started. Run `livekit-server --dev` then click Connect.");
  log("Open this page in two browser tabs to test sync.");
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => initializeApp());
} else {
  initializeApp();
}
