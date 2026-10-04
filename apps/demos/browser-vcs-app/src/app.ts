/**
 * Browser VCS App - Application Logic
 *
 * Handles UI interactions and VCS operations.
 */

import { Git } from "@statewalker/vcs-commands";
import { FileMode, type History } from "@statewalker/vcs-core";
import { FileStagingStore } from "@statewalker/vcs-store-files";
import type { Staging, WorkingCopy } from "@statewalker/vcs-working-tree";
import {
  createBrowserFsStorage,
  createMemoryStorage,
  hasGitDirectory,
  listAllFiles,
  type StorageBackend,
  type StorageType,
} from "./storage.js";

// UI Elements
let storageStatus: HTMLElement;
let repoStatus: HTMLElement;
let workingDirTree: HTMLElement;
let stagingTree: HTMLElement;
let commitHistory: HTMLElement;
let activityLog: HTMLElement;
let fileNameInput: HTMLInputElement;
let fileContentInput: HTMLTextAreaElement;
let commitMessageInput: HTMLInputElement;
let initBtn: HTMLButtonElement;

// App State
let currentStorage: StorageBackend | null = null;
let history: History | null = null;
let workingCopy: WorkingCopy | null = null;
let git: Git | null = null;
let staging: Staging | null = null;
const stagedFiles: Map<string, string> = new Map();
let workingDirFiles: string[] = [];
const trackedFiles: Set<string> = new Set();

/**
 * Initialize the application
 */
export async function createApp(): Promise<void> {
  // Get UI elements
  const storageStatusEl = document.getElementById("storage-status");
  const repoStatusEl = document.getElementById("repo-status");
  const workingDirTreeEl = document.getElementById("working-dir-tree");
  const stagingTreeEl = document.getElementById("staging-tree");
  const commitHistoryEl = document.getElementById("commit-history");
  const activityLogEl = document.getElementById("activity-log");

  if (
    !storageStatusEl ||
    !repoStatusEl ||
    !workingDirTreeEl ||
    !stagingTreeEl ||
    !commitHistoryEl ||
    !activityLogEl
  ) {
    throw new Error("Required UI elements not found");
  }

  storageStatus = storageStatusEl;
  repoStatus = repoStatusEl;
  workingDirTree = workingDirTreeEl;
  stagingTree = stagingTreeEl;
  commitHistory = commitHistoryEl;
  activityLog = activityLogEl;
  fileNameInput = document.getElementById("file-name") as HTMLInputElement;
  fileContentInput = document.getElementById("file-content") as HTMLTextAreaElement;
  commitMessageInput = document.getElementById("commit-message") as HTMLInputElement;
  initBtn = document.getElementById("btn-init") as HTMLButtonElement;

  // Setup event listeners
  setupEventListeners();

  // Initialize with memory storage
  await switchStorage("memory");

  log("App initialized", "info");
}

function setupEventListeners(): void {
  // Storage buttons
  document.getElementById("btn-memory")?.addEventListener("click", () => switchStorage("memory"));
  document
    .getElementById("btn-browser-fs")
    ?.addEventListener("click", () => switchStorage("browser-fs"));

  // Repository button
  document.getElementById("btn-init")?.addEventListener("click", initOrOpenRepository);

  // File buttons
  document.getElementById("btn-add-file")?.addEventListener("click", addFile);
  document.getElementById("btn-refresh")?.addEventListener("click", refreshWorkingDir);

  // Commit button
  document.getElementById("btn-commit")?.addEventListener("click", createCommit);
}

/**
 * Switch storage backend
 */
async function switchStorage(type: StorageType): Promise<void> {
  try {
    // Close existing history
    if (history) {
      await history.close();
      history = null;
      workingCopy = null;
      git = null;
    }

    // Create new storage
    if (type === "memory") {
      currentStorage = await createMemoryStorage();
    } else {
      currentStorage = await createBrowserFsStorage();
    }

    // Update UI
    updateStorageButtons(type);
    storageStatus.textContent = currentStorage.label;
    stagedFiles.clear();
    workingDirFiles = [];
    trackedFiles.clear();

    // Check if repository exists (for browser FS)
    if (type === "browser-fs" && currentStorage.rootHandle) {
      const hasRepo = await hasGitDirectory(currentStorage.rootHandle);
      if (hasRepo) {
        repoStatus.textContent = "Repository found - click to open";
        initBtn.textContent = "Open Repository";
        log("Existing .git directory found", "info");
      } else {
        repoStatus.textContent = "No repository";
        initBtn.textContent = "Initialize Repository";
      }

      // Always load working directory files for browser FS
      await refreshWorkingDir();
    } else {
      repoStatus.textContent = "No repository";
      initBtn.textContent = "Initialize Repository";
    }

    updateStagingTree();
    updateWorkingDirTree();
    updateCommitHistory();

    log(`Switched to ${currentStorage.label}`, "success");
  } catch (error) {
    log(`Failed to switch storage: ${(error as Error).message}`, "error");
  }
}

function updateStorageButtons(active: StorageType): void {
  const memoryBtn = document.getElementById("btn-memory");
  const browserBtn = document.getElementById("btn-browser-fs");

  if (!memoryBtn || !browserBtn) {
    throw new Error("Storage buttons not found");
  }

  memoryBtn.classList.toggle("active", active === "memory");
  browserBtn.classList.toggle("active", active === "browser-fs");
}

/**
 * Refresh working directory file list
 */
async function refreshWorkingDir(): Promise<void> {
  if (!currentStorage) return;

  try {
    if (currentStorage.type === "browser-fs" && currentStorage.rootHandle) {
      workingDirFiles = await listAllFiles(currentStorage.rootHandle);
      log(`Found ${workingDirFiles.length} files in working directory`, "info");
    } else {
      workingDirFiles = [];
    }

    // Update tracked files from repository
    await updateTrackedFiles();
    updateWorkingDirTree();
  } catch (error) {
    log(`Failed to list files: ${(error as Error).message}`, "error");
  }
}

/**
 * Update the set of tracked files from the repository
 */
async function updateTrackedFiles(): Promise<void> {
  trackedFiles.clear();

  if (!history) return;

  try {
    const headRef = await history.refs.resolve("HEAD");
    if (!headRef?.objectId) return;

    const commit = await history.commits.load(headRef.objectId);
    if (!commit) return;
    await collectTreeFiles(commit.tree, "");
  } catch {
    // No commits yet
  }
}

/**
 * Recursively collect files from a tree
 */
async function collectTreeFiles(treeId: string, prefix: string): Promise<void> {
  if (!history) return;

  const tree = await history.trees.load(treeId);
  if (!tree) return;

  for await (const entry of tree) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;

    if (entry.mode === FileMode.TREE) {
      await collectTreeFiles(entry.id, path);
    } else {
      trackedFiles.add(path);
    }
  }
}

/**
 * Initialize a new repository or open an existing one
 */
async function initOrOpenRepository(): Promise<void> {
  if (!currentStorage) {
    log("No storage backend selected", "error");
    return;
  }

  try {
    // Check if repository already exists
    let repoExists = false;
    if (currentStorage.type === "browser-fs" && currentStorage.rootHandle) {
      repoExists = await hasGitDirectory(currentStorage.rootHandle);
    }

    // Configure staging store - use file-based for browser FS, memory for in-memory
    let customStaging: Staging | undefined;
    if (currentStorage.type === "browser-fs") {
      const fileStaging = new FileStagingStore(currentStorage.files, ".git/index");
      if (repoExists) {
        await fileStaging.read(); // Load existing index
      }
      customStaging = fileStaging;
      staging = fileStaging;
    }

    // Use Git.init() porcelain command to initialize or open the repository
    const initCommand = Git.init()
      .setFilesApi(currentStorage.files)
      .setGitDir(".git")
      .setInitialBranch("main")
      .setWorktree(true);

    // Use custom staging if provided (for native git compatibility)
    if (customStaging) {
      initCommand.setStagingStore(customStaging);
    }

    const result = await initCommand.call();

    // Extract result
    history = result.repository;
    workingCopy = result.workingCopy;
    git = result.git;

    // For memory storage, keep reference to staging
    if (!customStaging) {
      staging = result.workingCopy.checkout.staging;
    }

    // Get current branch
    const branch = (await workingCopy.getCurrentBranch()) || "main";

    repoStatus.textContent = `Repository ready (${branch})`;
    initBtn.textContent = "Repository Ready";
    initBtn.disabled = true;
    stagedFiles.clear();

    // Refresh working directory and tracked files
    await refreshWorkingDir();
    await updateCommitHistory();

    log(repoExists ? "Opened existing repository" : "Initialized new repository", "success");
  } catch (error) {
    log(
      `Failed to ${history ? "open" : "initialize"} repository: ${(error as Error).message}`,
      "error",
    );
  }
}

/**
 * Add a file to staging
 */
async function addFile(): Promise<void> {
  if (!history || !git || !currentStorage) {
    log("No repository initialized", "error");
    return;
  }

  const fileName = fileNameInput.value.trim();
  const content = fileContentInput.value;

  if (!fileName) {
    log("Please enter a file name", "error");
    return;
  }

  try {
    const data = new TextEncoder().encode(content);

    // Write the file to storage (works for both MemFilesApi and browser FilesApi)
    await currentStorage.files.write(fileName, [data]);

    // Use porcelain git.add() command
    await git.add().addFilepattern(fileName).call();

    // Write index file so native git sees staged files (browser FS only)
    if (staging instanceof FileStagingStore) {
      try {
        await staging.write();
      } catch (e) {
        console.warn("Failed to write index file:", e);
      }
    }

    // Track staged file
    stagedFiles.set(fileName, content);

    // Clear inputs
    fileNameInput.value = "";
    fileContentInput.value = "";

    // Update UI
    await refreshWorkingDir();
    updateStagingTree();

    log(`Added file: ${fileName}`, "success");
  } catch (error) {
    log(`Failed to add file: ${(error as Error).message}`, "error");
  }
}

/**
 * Stage an existing file from working directory
 */
async function stageFile(fileName: string): Promise<void> {
  if (!history || !git || !currentStorage) {
    log("No repository initialized", "error");
    return;
  }

  try {
    // Use porcelain git.add() command
    await git.add().addFilepattern(fileName).call();

    // Write index file so native git sees staged files (browser FS only)
    if (staging instanceof FileStagingStore) {
      try {
        await staging.write();
      } catch (e) {
        console.warn("Failed to write index file:", e);
      }
    }

    // Read file content for tracking in UI
    const chunks: Uint8Array[] = [];
    for await (const chunk of currentStorage.files.read(fileName)) {
      chunks.push(chunk);
    }
    const content = new Uint8Array(chunks.reduce((acc, c) => acc + c.length, 0));
    let offset = 0;
    for (const chunk of chunks) {
      content.set(chunk, offset);
      offset += chunk.length;
    }

    // Track staged file
    stagedFiles.set(fileName, new TextDecoder().decode(content));

    // Update UI
    updateStagingTree();
    updateWorkingDirTree();

    log(`Staged file: ${fileName}`, "success");
  } catch (error) {
    log(`Failed to stage file: ${(error as Error).message}`, "error");
  }
}

/**
 * Create a new commit
 */
async function createCommit(): Promise<void> {
  if (!history || !git) {
    log("No repository initialized", "error");
    return;
  }

  const message = commitMessageInput.value.trim();
  if (!message) {
    log("Please enter a commit message", "error");
    return;
  }

  if (stagedFiles.size === 0) {
    log("No files staged for commit", "error");
    return;
  }

  try {
    // Create commit (Git.commit() stores the commit and returns its id)
    const commit = await git.commit().setMessage(message).call();
    const commitId = commit.id;

    // For browser FS, sync staging with the committed tree and write to index
    // This ensures native git sees the correct state
    if (currentStorage?.type === "browser-fs" && staging instanceof FileStagingStore) {
      try {
        // Read the committed tree back into staging (this keeps staging in sync with git)
        await staging.readTree(history.trees, commit.tree);
        // Write the index file so native git sees the correct state
        await staging.write();
      } catch (syncError) {
        // Index sync is best-effort - commit still succeeded
        console.warn("Failed to sync index file:", syncError);
      }
    }

    // Clear staged files
    stagedFiles.clear();

    // Clear input
    commitMessageInput.value = "";

    // Update UI
    await updateTrackedFiles();
    updateStagingTree();
    updateWorkingDirTree();
    await updateCommitHistory();

    log(`Created commit: ${commitId.slice(0, 7)}`, "success");
  } catch (error) {
    log(`Failed to create commit: ${(error as Error).message}`, "error");
  }
}

/**
 * Update the working directory tree display
 */
function updateWorkingDirTree(): void {
  if (workingDirFiles.length === 0) {
    workingDirTree.innerHTML = '<p class="empty-state">No files in working directory</p>';
    return;
  }

  const items = workingDirFiles
    .map((name) => {
      const isTracked = trackedFiles.has(name);
      const isStaged = stagedFiles.has(name);
      let status = "";
      let statusClass = "";

      if (isStaged) {
        status = "staged";
        statusClass = "status-staged";
      } else if (isTracked) {
        status = "tracked";
        statusClass = "status-tracked";
      } else {
        status = "untracked";
        statusClass = "status-untracked";
      }

      const canStage = !isStaged && history;

      return `
      <div class="file-item ${statusClass}">
        <span class="file-icon">📄</span>
        <span class="file-name">${escapeHtml(name)}</span>
        <span class="file-status">${status}</span>
        ${canStage ? `<button class="btn-stage" data-file="${escapeHtml(name)}">Stage</button>` : ""}
      </div>
    `;
    })
    .join("");

  workingDirTree.innerHTML = items;

  // Add click handlers for stage buttons
  workingDirTree.querySelectorAll(".btn-stage").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      const fileName = (e.target as HTMLElement).getAttribute("data-file");
      if (fileName) stageFile(fileName);
    });
  });
}

/**
 * Update the staging tree display
 */
function updateStagingTree(): void {
  if (stagedFiles.size === 0) {
    stagingTree.innerHTML = '<p class="empty-state">No files staged</p>';
    return;
  }

  const items = Array.from(stagedFiles.keys())
    .sort()
    .map(
      (name) => `
      <div class="file-item status-staged">
        <span class="file-icon">📄</span>
        <span class="file-name">${escapeHtml(name)}</span>
        <span class="file-status">staged</span>
      </div>
    `,
    )
    .join("");

  stagingTree.innerHTML = items;
}

/**
 * Update the commit history display
 */
async function updateCommitHistory(): Promise<void> {
  if (!git || !history) {
    commitHistory.innerHTML = '<p class="empty-state">No commits yet</p>';
    return;
  }

  try {
    const headRef = await history.refs.resolve("HEAD");
    if (!headRef?.objectId) {
      commitHistory.innerHTML = '<p class="empty-state">No commits yet</p>';
      return;
    }

    const commits: { id: string; message: string }[] = [];

    // Walk ancestry to get commit IDs
    const commitIds: string[] = [];
    for await (const id of history.commits.walkAncestry(headRef.objectId, { limit: 10 })) {
      commitIds.push(id);
    }

    // Load commit messages
    for (const id of commitIds) {
      const commit = await history.commits.load(id);
      if (!commit) continue;
      commits.push({
        id,
        message: commit.message.trim().split("\n")[0],
      });
    }

    if (commits.length === 0) {
      commitHistory.innerHTML = '<p class="empty-state">No commits yet</p>';
      return;
    }

    const items = commits
      .map(
        (c) => `
        <div class="commit-item">
          <span class="commit-hash">${c.id.slice(0, 7)}</span>
          <div class="commit-message">${escapeHtml(c.message)}</div>
        </div>
      `,
      )
      .join("");

    commitHistory.innerHTML = items;
  } catch (error) {
    log(`Failed to load commit history: ${(error as Error).message}`, "error");
    commitHistory.innerHTML = '<p class="empty-state">Error loading commits</p>';
  }
}

/**
 * Log a message to the activity log
 */
function log(message: string, type: "info" | "success" | "error" = "info"): void {
  const timestamp = new Date().toLocaleTimeString();
  const entry = document.createElement("div");
  entry.className = `log-entry ${type}`;
  entry.textContent = `[${timestamp}] ${message}`;

  activityLog.insertBefore(entry, activityLog.firstChild);

  // Keep only last 50 entries
  while (activityLog.children.length > 50 && activityLog.lastChild) {
    activityLog.removeChild(activityLog.lastChild);
  }
}

/**
 * Escape HTML special characters
 */
function escapeHtml(text: string): string {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}
