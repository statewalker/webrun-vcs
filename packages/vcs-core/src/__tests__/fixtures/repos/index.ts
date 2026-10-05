import type { History } from "../../../history/history.js";
import type { TreeEntry } from "../../../history/trees/tree-entry.js";

/**
 * Repository fixtures - pre-built git repositories for testing.
 *
 * These are specifications that can be used to create repository
 * states programmatically rather than storing binary .git directories.
 */
export const REPO_FIXTURES = {
  /**
   * Simple repository with linear history
   */
  simple: {
    description: "5 commits, single branch",
    branches: ["main"],
    commitCount: 5,
    setup: async (history: History): Promise<void> => {
      await createRepoFixture(history, {
        commits: [
          { message: "Initial commit", files: { "README.md": "# Project\n" } },
          {
            message: "Add file",
            files: { "README.md": "# Project\n", "file.txt": "content\n" },
          },
          {
            message: "Update file",
            files: {
              "README.md": "# Project\n",
              "file.txt": "updated content\n",
            },
          },
          {
            message: "Add another file",
            files: {
              "README.md": "# Project\n",
              "file.txt": "updated content\n",
              "other.txt": "other\n",
            },
          },
          {
            message: "Final commit",
            files: {
              "README.md": "# Project\n\nDescription\n",
              "file.txt": "updated content\n",
              "other.txt": "other\n",
            },
          },
        ],
        branches: { main: 4 }, // main points to last commit (index 4)
      });
    },
  },

  /**
   * Repository with merge conflict
   */
  mergeConflict: {
    description: "Two branches with conflicting changes",
    branches: ["main", "feature"],
    state: "MERGING",
    conflicts: ["file.txt"],
    setup: async (history: History): Promise<void> => {
      await createRepoFixture(history, {
        commits: [
          { message: "Initial", files: { "file.txt": "line1\nline2\n" } },
          {
            message: "Main change",
            files: { "file.txt": "line1\nmain change\n" },
            parents: [0],
          },
          {
            message: "Feature change",
            files: { "file.txt": "line1\nfeature change\n" },
            parents: [0],
          },
        ],
        branches: {
          main: 1,
          feature: 2,
        },
      });
    },
  },

  /**
   * Repository with complex history
   */
  complexHistory: {
    description: "Multiple branches, merges, tags",
    branches: ["main", "develop", "feature-a", "feature-b"],
    tags: ["v1.0.0", "v1.1.0", "v2.0.0"],
    commitCount: 15,
    setup: async (history: History): Promise<void> => {
      // Create a more complex branching structure
      const commits: Array<{
        message: string;
        files: Record<string, string>;
        parents?: number[];
      }> = [];

      // Initial commits on main
      commits.push({ message: "Initial", files: { "README.md": "# Proj\n" } });
      commits.push({
        message: "Add feature",
        files: { "README.md": "# Proj\n", "feature.js": "code\n" },
      });

      // Branch to develop
      commits.push({
        message: "Dev work",
        files: {
          "README.md": "# Proj\n",
          "feature.js": "code\n",
          "dev.js": "dev\n",
        },
        parents: [1],
      });

      // More development
      commits.push({
        message: "More dev",
        files: {
          "README.md": "# Proj\n",
          "feature.js": "code\n",
          "dev.js": "dev updated\n",
        },
      });

      // Merge back to main
      commits.push({
        message: "Merge develop",
        files: {
          "README.md": "# Proj\n",
          "feature.js": "code\n",
          "dev.js": "dev updated\n",
        },
        parents: [1, 3],
      });

      await createRepoFixture(history, {
        commits,
        branches: {
          main: 4,
          develop: 3,
        },
        tags: {
          "v1.0.0": 1,
          "v2.0.0": 4,
        },
      });
    },
  },
} as const;

/**
 * Helper to create an async iterable from a Uint8Array.
 */
async function* toAsyncIterable(data: Uint8Array): AsyncIterable<Uint8Array> {
  yield data;
}

/**
 * Create repository fixture programmatically.
 */
export async function createRepoFixture(history: History, spec: RepoSpec): Promise<void> {
  const commitIds: string[] = [];

  // Create commits
  for (let i = 0; i < spec.commits.length; i++) {
    const commitSpec = spec.commits[i];

    // Create blobs for all files
    const entries: TreeEntry[] = [];
    for (const [name, content] of Object.entries(commitSpec.files)) {
      const blobId = await history.blobs.store(toAsyncIterable(new TextEncoder().encode(content)));
      entries.push({
        mode: 0o100644,
        name,
        id: blobId,
      });
    }

    // Sort entries by name (git requirement)
    entries.sort((a, b) => a.name.localeCompare(b.name));

    // Create tree (pass array directly, not object with entries property)
    const treeId = await history.trees.store(entries);

    // Determine parents
    const parents =
      commitSpec.parents?.map((idx) => commitIds[idx]) ?? (i > 0 ? [commitIds[i - 1]] : []);

    // Create commit
    const commitId = await history.commits.store({
      tree: treeId,
      parents,
      author: {
        name: "Test Author",
        email: "test@test.com",
        timestamp: 1700000000 + i * 1000,
        tzOffset: "+0000",
      },
      committer: {
        name: "Test Committer",
        email: "test@test.com",
        timestamp: 1700000000 + i * 1000,
        tzOffset: "+0000",
      },
      message: commitSpec.message,
    });

    commitIds.push(commitId);
  }

  // Create branches
  if (spec.branches) {
    for (const [branchName, commitIdx] of Object.entries(spec.branches)) {
      await history.refs.setSymbolic(`refs/heads/${branchName}`, commitIds[commitIdx]);
    }
  }

  // Create tags
  if (spec.tags) {
    for (const [tagName, commitIdx] of Object.entries(spec.tags)) {
      await history.refs.set(`refs/tags/${tagName}`, commitIds[commitIdx]);
    }
  }
}

export interface RepoSpec {
  commits: Array<{
    message: string;
    files: Record<string, string>;
    parents?: number[]; // Indices of parent commits
  }>;
  branches?: Record<string, number>; // Branch name -> commit index
  tags?: Record<string, number>; // Tag name -> commit index
}
