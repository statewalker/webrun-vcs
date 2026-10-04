/**
 * Offline-First PWA Main Entry
 *
 * Demonstrates Git operations that work completely offline.
 */

import { Git } from "@statewalker/vcs-commands";
import { FileMode, type History } from "@statewalker/vcs-core";
import type { WorkingCopy } from "@statewalker/vcs-working-tree";
import {
  createMemoryStorage,
  createPersistentStorage,
  isPersistentStorageAvailable,
  type StorageBackend,
  type StorageType,
} from "./storage-manager.js";

// App state
let currentStorage: StorageBackend | null = null;
let history: History | null = null;
let workingCopy: WorkingCopy | null = null;
let git: Git | null = null;
const stagedFiles = new Map<string, string>();

// DOM Elements
const connectionStatus = document.getElementById("connection-status") as HTMLElement;
const statusIndicator = connectionStatus.querySelector(".status-indicator") as HTMLElement;
const statusText = connectionStatus.querySelector(".status-text") as HTMLElement;

const btnMemory = document.getElementById("btn-memory") as HTMLButtonElement;
const btnPersistent = document.getElementById("btn-persistent") as HTMLButtonElement;
const storageStatus = document.getElementById("storage-status") as HTMLElement;

const btnInit = document.getElementById("btn-init") as HTMLButtonElement;
const repoStatus = document.getElementById("repo-status") as HTMLElement;

const fileNameInput = document.getElementById("file-name") as HTMLInputElement;
const fileContentInput = document.getElementById("file-content") as HTMLTextAreaElement;
const btnAddFile = document.getElementById("btn-add-file") as HTMLButtonElement;
const stagedList = document.getElementById("staged-list") as HTMLElement;

const commitMessageInput = document.getElementById("commit-message") as HTMLInputElement;
const btnCommit = document.getElementById("btn-commit") as HTMLButtonElement;
const commitList = document.getElementById("commit-list") as HTMLElement;

const pwaStatus = document.getElementById("pwa-status") as HTMLElement;
const btnInstall = document.getElementById("btn-install") as HTMLButtonElement;

// PWA Install
let deferredPrompt: BeforeInstallPromptEvent | null = null;

interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

// Initialize app
async function init() {
  // Set up event listeners
  setupEventListeners();

  // Initialize with memory storage
  await switchStorage("memory");

  // Set up connection monitoring
  setupConnectionMonitor();

  // Set up PWA install
  setupPwaInstall();

  // Check if running as installed PWA
  checkPwaMode();
}

function setupEventListeners() {
  btnMemory.addEventListener("click", () => switchStorage("memory"));
  btnPersistent.addEventListener("click", () => switchStorage("persistent"));
  btnInit.addEventListener("click", initRepository);
  btnAddFile.addEventListener("click", addFile);
  btnCommit.addEventListener("click", createCommit);
}

function setupConnectionMonitor() {
  const updateStatus = () => {
    const online = navigator.onLine;
    statusIndicator.classList.toggle("offline", !online);
    statusText.textContent = online ? "Online" : "Offline";
  };

  window.addEventListener("online", updateStatus);
  window.addEventListener("offline", updateStatus);
  updateStatus();
}

function setupPwaInstall() {
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e as BeforeInstallPromptEvent;
    btnInstall.style.display = "inline-block";
    pwaStatus.textContent = "App can be installed";
  });

  btnInstall.addEventListener("click", async () => {
    if (!deferredPrompt) return;

    await deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;

    if (outcome === "accepted") {
      pwaStatus.textContent = "App installed!";
      btnInstall.style.display = "none";
    }

    deferredPrompt = null;
  });

  window.addEventListener("appinstalled", () => {
    pwaStatus.textContent = "App installed";
    btnInstall.style.display = "none";
    deferredPrompt = null;
  });
}

function checkPwaMode() {
  const isStandalone =
    window.matchMedia("(display-mode: standalone)").matches ||
    (window.navigator as Navigator & { standalone?: boolean }).standalone === true;

  if (isStandalone) {
    pwaStatus.textContent = "Running as installed app";
  }
}

async function switchStorage(type: StorageType) {
  try {
    // Reset state
    history = null;
    workingCopy = null;
    git = null;
    stagedFiles.clear();

    // Create new storage
    if (type === "memory") {
      currentStorage = await createMemoryStorage();
    } else {
      currentStorage = await createPersistentStorage();
    }

    // Update UI
    btnMemory.classList.toggle("active", type === "memory");
    btnPersistent.classList.toggle("active", type === "persistent");
    storageStatus.textContent = currentStorage.label;

    // Reset repository UI
    btnInit.disabled = false;
    btnInit.textContent = "Initialize Repository";
    repoStatus.textContent = "No repository";

    // Update file lists
    updateStagedList();
    updateCommitList();

    // Disable persistent if not available
    if (!isPersistentStorageAvailable()) {
      btnPersistent.disabled = true;
      btnPersistent.title = "Persistent storage not available in this browser";
    }
  } catch (error) {
    console.error("Failed to switch storage:", error);
    storageStatus.textContent = `Error: ${(error as Error).message}`;
  }
}

async function initRepository() {
  if (!currentStorage) {
    repoStatus.textContent = "No storage selected";
    return;
  }

  try {
    const result = await Git.init()
      .setFilesApi(currentStorage.files)
      .setGitDir(".git")
      .setInitialBranch("main")
      .call();

    history = result.repository;
    workingCopy = result.workingCopy;
    git = result.git;

    btnInit.disabled = true;
    btnInit.textContent = "Repository Ready";
    repoStatus.textContent = "Repository initialized (main branch)";

    stagedFiles.clear();
    updateStagedList();
    updateCommitList();
  } catch (error) {
    console.error("Failed to initialize repository:", error);
    repoStatus.textContent = `Error: ${(error as Error).message}`;
  }
}

async function addFile() {
  if (!history || !workingCopy || !git) {
    repoStatus.textContent = "Initialize repository first";
    return;
  }

  const fileName = fileNameInput.value.trim();
  const content = fileContentInput.value;

  if (!fileName) {
    return;
  }

  try {
    // Store blob
    const data = new TextEncoder().encode(content);
    const objectId = await history.blobs.store([data]);

    // Add to staging
    const editor = workingCopy.checkout.staging.createEditor();
    editor.add({
      path: fileName,
      apply: () => ({
        path: fileName,
        mode: FileMode.REGULAR_FILE,
        objectId,
        stage: 0,
        size: data.length,
        mtime: Date.now(),
      }),
    });
    await editor.finish();

    // Track in UI
    stagedFiles.set(fileName, content);

    // Clear inputs
    fileNameInput.value = "";
    fileContentInput.value = "";

    // Update UI
    updateStagedList();
  } catch (error) {
    console.error("Failed to add file:", error);
  }
}

function updateStagedList() {
  if (stagedFiles.size === 0) {
    stagedList.innerHTML = '<p class="empty">No staged files</p>';
    return;
  }

  stagedList.innerHTML = Array.from(stagedFiles.keys())
    .sort()
    .map(
      (name) => `
      <div class="file-item">
        <span class="icon">📄</span>
        <span>${escapeHtml(name)}</span>
      </div>
    `,
    )
    .join("");
}

async function createCommit() {
  if (!history || !git) {
    repoStatus.textContent = "Initialize repository first";
    return;
  }

  const message = commitMessageInput.value.trim();
  if (!message) {
    return;
  }

  if (stagedFiles.size === 0) {
    repoStatus.textContent = "No files staged";
    return;
  }

  try {
    const commitResult = await git.commit().setMessage(message).call();

    // Clear staged files
    stagedFiles.clear();
    commitMessageInput.value = "";

    // Update UI
    updateStagedList();
    updateCommitList();

    repoStatus.textContent = `Created commit: ${commitResult.id.slice(0, 7)}`;
  } catch (error) {
    console.error("Failed to create commit:", error);
    repoStatus.textContent = `Error: ${(error as Error).message}`;
  }
}

async function updateCommitList() {
  if (!history) {
    commitList.innerHTML = '<p class="empty">No commits yet</p>';
    return;
  }

  try {
    const head = await history.refs.resolve("HEAD");
    if (!head?.objectId) {
      commitList.innerHTML = '<p class="empty">No commits yet</p>';
      return;
    }

    const commits: Array<{ id: string; message: string; date: Date }> = [];

    for await (const id of history.commits.walkAncestry(head.objectId)) {
      const commit = await history.commits.load(id);
      if (commit) {
        commits.push({
          id,
          message: commit.message.trim(),
          date: new Date(commit.author.timestamp * 1000),
        });
      }
      if (commits.length >= 10) break;
    }

    if (commits.length === 0) {
      commitList.innerHTML = '<p class="empty">No commits yet</p>';
      return;
    }

    commitList.innerHTML = commits
      .map(
        (c) => `
        <div class="commit-item">
          <div class="commit-id">${c.id.slice(0, 7)}</div>
          <div class="commit-message">${escapeHtml(c.message.split("\n")[0])}</div>
          <div class="commit-date">${formatDate(c.date)}</div>
        </div>
      `,
      )
      .join("");
  } catch (error) {
    console.error("Failed to load commits:", error);
    commitList.innerHTML = '<p class="empty">Error loading commits</p>';
  }
}

function formatDate(date: Date): string {
  return date.toLocaleString();
}

function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

// Start app
init();
