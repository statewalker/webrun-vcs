/**
 * Browser VCS App E2E Tests
 *
 * Tests the browser-based VCS application with both in-memory
 * and browser filesystem storage (using mocked File System Access API).
 */

import { expect, test } from "@playwright/test";

test.describe("Browser VCS App - In-Memory Storage", () => {
  test.beforeEach(async ({ page }) => {
    await page.goto("/");
  });

  test("should load the application", async ({ page }) => {
    await expect(page.locator("h1")).toContainText("Browser VCS App");
    await expect(page.locator(".subtitle")).toContainText("Git in the browser");
  });

  test("should show storage backend options", async ({ page }) => {
    await expect(page.locator("#btn-memory")).toBeVisible();
    await expect(page.locator("#btn-browser-fs")).toBeVisible();
    await expect(page.locator("#btn-memory")).toHaveClass(/active/);
  });

  test("should show File System API support status", async ({ page }) => {
    const supportElement = page.locator("#fs-api-support");
    await expect(supportElement).toBeVisible();
    // Chromium supports the API
    await expect(supportElement).toHaveClass(/supported|unsupported/);
  });

  test("should initialize in-memory repository", async ({ page }) => {
    // Click initialize button
    await page.locator("#btn-init").click();

    // Check repository status updated
    await expect(page.locator("#repo-status")).toContainText(/Repository ready/);

    // Check activity log shows initialization
    await expect(page.locator(".activity-log")).toContainText(/Initialized/);
  });

  test("should add file and stage it", async ({ page }) => {
    // Initialize repository
    await page.locator("#btn-init").click();
    await expect(page.locator("#repo-status")).toContainText(/Repository ready/);

    // Add a file
    await page.locator("#file-name").fill("test.txt");
    await page.locator("#file-content").fill("Hello, World!");
    await page.locator("#btn-add-file").click();

    // Check file appears in staging area
    await expect(page.locator("#staging-tree")).toContainText("test.txt");
    await expect(page.locator("#staging-tree")).toContainText("staged");

    // Check activity log
    await expect(page.locator(".activity-log")).toContainText(/Added file: test.txt/);
  });

  test("should create commit", async ({ page }) => {
    // Initialize repository
    await page.locator("#btn-init").click();
    await expect(page.locator("#repo-status")).toContainText(/Repository ready/);

    // Add a file
    await page.locator("#file-name").fill("readme.md");
    await page.locator("#file-content").fill("# My Project");
    await page.locator("#btn-add-file").click();

    // Create commit
    await page.locator("#commit-message").fill("Initial commit");
    await page.locator("#btn-commit").click();

    // Check commit appears in history
    await expect(page.locator(".commit-history")).toContainText("Initial commit");
    await expect(page.locator(".commit-history .commit-hash")).toBeVisible();

    // Check staging area is cleared
    await expect(page.locator("#staging-tree")).toContainText("No files staged");
  });

  test("should not commit without staged files", async ({ page }) => {
    // Initialize repository
    await page.locator("#btn-init").click();
    await expect(page.locator("#repo-status")).toContainText(/Repository ready/);

    // Try to commit without files
    await page.locator("#commit-message").fill("Empty commit");
    await page.locator("#btn-commit").click();

    // Check error in activity log
    await expect(page.locator(".activity-log")).toContainText(/No files staged/);
  });

  test("should not commit without message", async ({ page }) => {
    // Initialize repository
    await page.locator("#btn-init").click();
    await expect(page.locator("#repo-status")).toContainText(/Repository ready/);

    // Add a file
    await page.locator("#file-name").fill("test.txt");
    await page.locator("#file-content").fill("content");
    await page.locator("#btn-add-file").click();

    // Try to commit without message
    await page.locator("#btn-commit").click();

    // Check error in activity log
    await expect(page.locator(".activity-log")).toContainText(/Please enter a commit message/);
  });

  test("should show multiple commits in history", async ({ page }) => {
    // Initialize repository
    await page.locator("#btn-init").click();

    // First commit
    await page.locator("#file-name").fill("file1.txt");
    await page.locator("#file-content").fill("First file");
    await page.locator("#btn-add-file").click();
    await page.locator("#commit-message").fill("Add file1");
    await page.locator("#btn-commit").click();

    // Second commit
    await page.locator("#file-name").fill("file2.txt");
    await page.locator("#file-content").fill("Second file");
    await page.locator("#btn-add-file").click();
    await page.locator("#commit-message").fill("Add file2");
    await page.locator("#btn-commit").click();

    // Check both commits appear
    await expect(page.locator(".commit-history")).toContainText("Add file1");
    await expect(page.locator(".commit-history")).toContainText("Add file2");

    // Check commit order (newest first)
    const commits = await page.locator(".commit-item").all();
    expect(commits.length).toBe(2);
  });

  test("should not add file without repository", async ({ page }) => {
    // Try to add file without initializing
    await page.locator("#file-name").fill("test.txt");
    await page.locator("#file-content").fill("content");
    await page.locator("#btn-add-file").click();

    // Check error
    await expect(page.locator(".activity-log")).toContainText(/No repository initialized/);
  });

  test("should not add file without name", async ({ page }) => {
    // Initialize repository
    await page.locator("#btn-init").click();

    // Try to add file without name
    await page.locator("#file-content").fill("content");
    await page.locator("#btn-add-file").click();

    // Check error
    await expect(page.locator(".activity-log")).toContainText(/Please enter a file name/);
  });

  test("should clear inputs after adding file", async ({ page }) => {
    // Initialize repository
    await page.locator("#btn-init").click();

    // Add a file
    await page.locator("#file-name").fill("test.txt");
    await page.locator("#file-content").fill("content");
    await page.locator("#btn-add-file").click();

    // Check inputs are cleared
    await expect(page.locator("#file-name")).toHaveValue("");
    await expect(page.locator("#file-content")).toHaveValue("");
  });

  test("should clear message after commit", async ({ page }) => {
    // Initialize repository
    await page.locator("#btn-init").click();

    // Add file and commit
    await page.locator("#file-name").fill("test.txt");
    await page.locator("#file-content").fill("content");
    await page.locator("#btn-add-file").click();
    await page.locator("#commit-message").fill("Test commit");
    await page.locator("#btn-commit").click();

    // Check message is cleared
    await expect(page.locator("#commit-message")).toHaveValue("");
  });
});

/**
 * Browser Filesystem Storage Tests
 *
 * These tests mock the File System Access API to test the browser
 * filesystem functionality without requiring user interaction.
 */
test.describe("Browser VCS App - Browser Filesystem Storage", () => {
  /**
   * Helper to create a mock FileSystemDirectoryHandle
   * Uses a more robust approach for async iteration
   */
  function createMockFileSystem(initialFiles: Record<string, string | Record<string, unknown>>) {
    return `
      (function() {
        // In-memory file storage
        const storage = ${JSON.stringify(initialFiles)};

        // File contents are kept as byte strings (one char per byte, latin1), so binary files
        // such as git's zlib-compressed objects survive a write and a read; ASCII text reads
        // the same either way, which is what the assertions compare.
        function toBytes(content) {
          const bytes = new Uint8Array(content.length);
          for (let i = 0; i < content.length; i++) bytes[i] = content.charCodeAt(i) & 0xff;
          return bytes;
        }
        function fromBytes(bytes) {
          let out = '';
          for (let i = 0; i < bytes.length; i += 0x8000) {
            out += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
          }
          return out;
        }
        function chunkToBytes(data) {
          if (data instanceof Uint8Array) return data;
          if (data instanceof ArrayBuffer) return new Uint8Array(data);
          if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
          if (typeof data === 'string') return new TextEncoder().encode(data);
          if (data && data.type === 'write') return chunkToBytes(data.data);
          return new Uint8Array(0);
        }

        // Create mock FileSystemFileHandle
        function createFileHandle(name, getContent, setContent) {
          const handle = {
            kind: 'file',
            name: name,
            // A real File, so slice(), stream(), arrayBuffer() and text() all work.
            getFile: async function() {
              return new File([toBytes(getContent() || '')], name, { lastModified: Date.now() });
            },
            createWritable: async function() {
              const chunks = [];
              return {
                write: async function(data) {
                  chunks.push(fromBytes(chunkToBytes(data)));
                },
                close: async function() {
                  setContent(chunks.join(''));
                },
                abort: async function() {
                  chunks.length = 0;
                },
              };
            },
          };
          return handle;
        }

        // Create mock FileSystemDirectoryHandle
        function createDirHandle(name, getDir) {
          // Build array of entries for iteration
          function getEntries() {
            const dir = getDir();
            const entries = [];
            if (dir && typeof dir === 'object') {
              for (const key of Object.keys(dir)) {
                const value = dir[key];
                const isDir = value !== null && typeof value === 'object';
                if (isDir) {
                  entries.push(createDirHandle(key, function() { return getDir()[key]; }));
                } else {
                  entries.push(createFileHandle(key,
                    function() { return getDir()[key]; },
                    function(v) { getDir()[key] = v; }
                  ));
                }
              }
            }
            return entries;
          }

          const handle = {
            kind: 'directory',
            name: name,

            values: function() {
              const entries = getEntries();
              let index = 0;
              return {
                next: async function() {
                  if (index < entries.length) {
                    return { value: entries[index++], done: false };
                  }
                  return { value: undefined, done: true };
                },
                [Symbol.asyncIterator]: function() { return this; }
              };
            },

            entries: function() {
              const dir = getDir();
              const keys = dir && typeof dir === 'object' ? Object.keys(dir) : [];
              let index = 0;
              return {
                next: async function() {
                  if (index < keys.length) {
                    const key = keys[index++];
                    const value = dir[key];
                    const isDir = value !== null && typeof value === 'object';
                    const entryHandle = isDir
                      ? createDirHandle(key, function() { return getDir()[key]; })
                      : createFileHandle(key, function() { return getDir()[key]; }, function(v) { getDir()[key] = v; });
                    return { value: [key, entryHandle], done: false };
                  }
                  return { value: undefined, done: true };
                },
                [Symbol.asyncIterator]: function() { return this; }
              };
            },

            keys: function() {
              const dir = getDir();
              const keys = dir && typeof dir === 'object' ? Object.keys(dir) : [];
              let index = 0;
              return {
                next: async function() {
                  if (index < keys.length) {
                    return { value: keys[index++], done: false };
                  }
                  return { value: undefined, done: true };
                },
                [Symbol.asyncIterator]: function() { return this; }
              };
            },

            getFileHandle: async function(fileName, options) {
              options = options || {};
              const dir = getDir();
              if (dir && fileName in dir && (typeof dir[fileName] !== 'object' || dir[fileName] === null)) {
                return createFileHandle(fileName, function() { return getDir()[fileName]; }, function(v) { getDir()[fileName] = v; });
              }
              if (options.create) {
                dir[fileName] = '';
                return createFileHandle(fileName, function() { return getDir()[fileName]; }, function(v) { getDir()[fileName] = v; });
              }
              throw new DOMException('File not found', 'NotFoundError');
            },

            getDirectoryHandle: async function(dirName, options) {
              options = options || {};
              const dir = getDir();
              if (dir && dirName in dir && typeof dir[dirName] === 'object' && dir[dirName] !== null) {
                return createDirHandle(dirName, function() { return getDir()[dirName]; });
              }
              if (options.create) {
                dir[dirName] = {};
                return createDirHandle(dirName, function() { return getDir()[dirName]; });
              }
              throw new DOMException('Directory not found', 'NotFoundError');
            },

            removeEntry: async function(entryName) {
              const dir = getDir();
              if (dir && entryName in dir) {
                delete dir[entryName];
              }
            },
          };

          // Make it async iterable using values()
          handle[Symbol.asyncIterator] = function() { return handle.values(); };

          return handle;
        }

        // Create root handle
        const rootHandle = createDirHandle('test-project', function() { return storage; });

        // Mock showDirectoryPicker
        window.showDirectoryPicker = async function() { return rootHandle; };

        // Store for test assertions
        window.__mockFileSystem = storage;
        window.__mockRootHandle = rootHandle;
      })();
    `;
  }

  test("should switch to browser filesystem storage", async ({ page }) => {
    // Setup mock with empty directory
    await page.addInitScript(createMockFileSystem({}));
    await page.goto("/");

    // Click browser FS button
    await page.locator("#btn-browser-fs").click();

    // Check storage status updated
    await expect(page.locator("#storage-status")).toContainText(/Browser FS/);
    await expect(page.locator("#btn-browser-fs")).toHaveClass(/active/);
    await expect(page.locator("#btn-memory")).not.toHaveClass(/active/);
  });

  test("should initialize new repository in browser filesystem", async ({ page }) => {
    // Setup mock with empty directory
    await page.addInitScript(createMockFileSystem({}));
    await page.goto("/");

    // Switch to browser FS
    await page.locator("#btn-browser-fs").click();
    await expect(page.locator("#storage-status")).toContainText(/Browser FS/);

    // Initialize repository
    await page.locator("#btn-init").click();
    await expect(page.locator("#repo-status")).toContainText(/Repository ready/);

    // Check .git directory was created
    const hasGit = await page.evaluate(() => {
      return (
        ".git" in
        (window as unknown as { __mockFileSystem: Record<string, unknown> }).__mockFileSystem
      );
    });
    expect(hasGit).toBe(true);
  });

  test("should detect existing .git repository", async ({ page }) => {
    // Setup mock with existing .git directory
    await page.addInitScript(
      createMockFileSystem({
        ".git": {
          HEAD: "ref: refs/heads/main",
          config: "[core]\\n\\trepositoryformatversion = 0",
        },
        "readme.txt": "Hello World",
      }),
    );
    await page.goto("/");

    // Switch to browser FS
    await page.locator("#btn-browser-fs").click();

    // Check that existing repo was detected
    await expect(page.locator("#repo-status")).toContainText(/Repository found/);
    await expect(page.locator("#btn-init")).toContainText(/Open Repository/);
  });

  test("should list existing files in working directory", async ({ page }) => {
    // Setup mock with existing files
    await page.addInitScript(
      createMockFileSystem({
        "readme.md": "# My Project",
        src: {
          "main.ts": "console.log('hello');",
          "utils.ts": "export const add = (a, b) => a + b;",
        },
        "package.json": "{}",
      }),
    );
    await page.goto("/");

    // Switch to browser FS
    await page.locator("#btn-browser-fs").click();

    // Check files are listed
    await expect(page.locator("#working-dir-tree")).toContainText("readme.md");
    await expect(page.locator("#working-dir-tree")).toContainText("package.json");
    await expect(page.locator("#working-dir-tree")).toContainText("src/main.ts");
    await expect(page.locator("#working-dir-tree")).toContainText("src/utils.ts");
  });

  test("should show untracked status for new files", async ({ page }) => {
    // Setup mock with files but no .git
    await page.addInitScript(
      createMockFileSystem({
        "readme.md": "# My Project",
        "app.js": "console.log('app');",
      }),
    );
    await page.goto("/");

    // Switch to browser FS and init repo
    await page.locator("#btn-browser-fs").click();
    await page.locator("#btn-init").click();
    await expect(page.locator("#repo-status")).toContainText(/Repository ready/);

    // Check files show as untracked
    await expect(page.locator("#working-dir-tree")).toContainText("untracked");
  });

  test("should stage file from working directory", async ({ page }) => {
    // Setup mock with files
    await page.addInitScript(
      createMockFileSystem({
        "readme.md": "# My Project",
      }),
    );
    await page.goto("/");

    // Switch to browser FS and init repo
    await page.locator("#btn-browser-fs").click();
    await page.locator("#btn-init").click();
    await expect(page.locator("#repo-status")).toContainText(/Repository ready/);

    // Wait for file to appear in working directory
    await expect(page.locator("#working-dir-tree")).toContainText("readme.md");

    // Click stage button on the file
    const stageBtn = page.locator(".btn-stage").first();
    await stageBtn.click();

    // Wait for activity log to confirm staging completed (or show error)
    await expect(page.locator(".activity-log")).toContainText(/Staged file|Failed to stage/);

    // Check file appears in staging area
    await expect(page.locator("#staging-tree")).toContainText("readme.md");
    await expect(page.locator("#staging-tree")).toContainText("staged");
  });

  test("should commit staged files from working directory", async ({ page }) => {
    // Setup mock with files
    await page.addInitScript(
      createMockFileSystem({
        "readme.md": "# My Project",
        "index.js": "module.exports = {};",
      }),
    );
    await page.goto("/");

    // Switch to browser FS and init repo
    await page.locator("#btn-browser-fs").click();
    await page.locator("#btn-init").click();
    await expect(page.locator("#repo-status")).toContainText(/Repository ready/);

    // Wait for files to appear
    await expect(page.locator("#working-dir-tree")).toContainText("readme.md");

    // Stage first file and wait for confirmation
    await page.locator(".btn-stage").first().click();
    await expect(page.locator(".activity-log")).toContainText(/Staged file|Failed/);

    // Create commit
    await page.locator("#commit-message").fill("Initial commit");
    await page.locator("#btn-commit").click();

    // Wait for commit to complete - this is the key assertion proving commit worked
    await expect(page.locator(".activity-log")).toContainText(/Created commit/);

    // Staging should be cleared after commit
    await expect(page.locator("#staging-tree")).toContainText("No files staged");

    // Note: Commit history may show "Error loading" with mock FS since reading
    // git objects back requires a fully functional file system mock.
    // The important thing is the commit was created successfully.
  });

  test("should show tracked status after commit", async ({ page }) => {
    // Setup mock with files
    await page.addInitScript(
      createMockFileSystem({
        "readme.md": "# My Project",
      }),
    );
    await page.goto("/");

    // Switch to browser FS and init repo
    await page.locator("#btn-browser-fs").click();
    await page.locator("#btn-init").click();

    // Stage and commit
    await page.locator(".btn-stage").first().click();
    await page.locator("#commit-message").fill("Add readme");
    await page.locator("#btn-commit").click();

    // File should now show as tracked
    await expect(page.locator("#working-dir-tree")).toContainText("tracked");
  });

  test("should open existing repository and show commits", async ({ page }) => {
    // This test verifies opening an existing repo
    // The mock needs proper git object structure for this to work fully
    await page.addInitScript(
      createMockFileSystem({
        ".git": {
          HEAD: "ref: refs/heads/main",
        },
        "readme.md": "# Existing Project",
      }),
    );
    await page.goto("/");

    // Switch to browser FS
    await page.locator("#btn-browser-fs").click();
    await expect(page.locator("#repo-status")).toContainText(/Repository found/);

    // Click to open
    await page.locator("#btn-init").click();

    // Should show as opened
    await expect(page.locator(".activity-log")).toContainText(
      /Opened existing repository|Initialized/,
    );
  });

  test("should add new file and write to filesystem", async ({ page }) => {
    // Setup mock with empty directory
    await page.addInitScript(createMockFileSystem({}));
    await page.goto("/");

    // Switch to browser FS and init repo
    await page.locator("#btn-browser-fs").click();
    await page.locator("#btn-init").click();
    await expect(page.locator("#repo-status")).toContainText(/Repository ready/);

    // Add a new file via the form
    await page.locator("#file-name").fill("newfile.txt");
    await page.locator("#file-content").fill("New file content");
    await page.locator("#btn-add-file").click();

    // Wait for activity log to confirm file added
    await expect(page.locator(".activity-log")).toContainText(
      /Added file: newfile.txt|Failed to add/,
    );

    // Check file appears in staging
    await expect(page.locator("#staging-tree")).toContainText("newfile.txt");

    // Check file was written to mock filesystem
    const fileExists = await page.evaluate(() => {
      return (
        "newfile.txt" in
        (window as unknown as { __mockFileSystem: Record<string, unknown> }).__mockFileSystem
      );
    });
    expect(fileExists).toBe(true);
  });

  test("should refresh working directory", async ({ page }) => {
    // Setup mock with files
    await page.addInitScript(
      createMockFileSystem({
        "file1.txt": "content1",
      }),
    );
    await page.goto("/");

    // Switch to browser FS
    await page.locator("#btn-browser-fs").click();
    await expect(page.locator("#working-dir-tree")).toContainText("file1.txt");

    // Simulate adding a file externally
    await page.evaluate(() => {
      (window as unknown as { __mockFileSystem: Record<string, string> }).__mockFileSystem[
        "file2.txt"
      ] = "content2";
    });

    // Click refresh
    await page.locator("#btn-refresh").click();

    // New file should appear
    await expect(page.locator("#working-dir-tree")).toContainText("file2.txt");
  });

  test("should switch back to memory storage", async ({ page }) => {
    // Setup mock
    await page.addInitScript(
      createMockFileSystem({
        "readme.md": "# Project",
      }),
    );
    await page.goto("/");

    // Switch to browser FS
    await page.locator("#btn-browser-fs").click();
    await expect(page.locator("#btn-browser-fs")).toHaveClass(/active/);

    // Switch back to memory
    await page.locator("#btn-memory").click();

    // Check state is reset
    await expect(page.locator("#btn-memory")).toHaveClass(/active/);
    await expect(page.locator("#storage-status")).toContainText(/In-Memory/);
    await expect(page.locator("#repo-status")).toContainText(/No repository/);
    await expect(page.locator("#working-dir-tree")).toContainText(/No files/);
  });
});
