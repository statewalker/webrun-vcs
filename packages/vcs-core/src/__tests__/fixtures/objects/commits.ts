import type { PersonIdent } from "../../../common/person/person-ident.js";
import { TREE_FIXTURES } from "./trees.js";

/**
 * Test commit fixtures.
 */
export const COMMIT_FIXTURES = {
  /**
   * Initial commit (no parents)
   */
  initial: {
    tree: TREE_FIXTURES.singleFile.hash,
    parents: [] as string[],
    author: {
      name: "Test Author",
      email: "author@test.com",
      timestamp: 1700000000,
      tzOffset: "+0000",
    } as PersonIdent,
    committer: {
      name: "Test Committer",
      email: "committer@test.com",
      timestamp: 1700000000,
      tzOffset: "+0000",
    } as PersonIdent,
    message: "Initial commit\n",
    hash: "computed",
  },

  /**
   * Regular commit (one parent)
   */
  regular: {
    tree: TREE_FIXTURES.multipleFiles.hash,
    parents: ["placeholder-parent-hash"] as string[],
    author: {
      name: "Test Author",
      email: "author@test.com",
      timestamp: 1700001000,
      tzOffset: "+0000",
    } as PersonIdent,
    committer: {
      name: "Test Committer",
      email: "committer@test.com",
      timestamp: 1700001000,
      tzOffset: "+0000",
    } as PersonIdent,
    message: "Add more files\n",
    hash: "computed",
  },

  /**
   * Merge commit (two parents)
   */
  merge: {
    tree: TREE_FIXTURES.multipleFiles.hash,
    parents: ["placeholder-parent1-hash", "placeholder-parent2-hash"] as string[],
    author: {
      name: "Test Author",
      email: "author@test.com",
      timestamp: 1700002000,
      tzOffset: "+0000",
    } as PersonIdent,
    committer: {
      name: "Test Committer",
      email: "committer@test.com",
      timestamp: 1700002000,
      tzOffset: "+0000",
    } as PersonIdent,
    message: "Merge branch 'feature'\n",
    hash: "computed",
  },
} as const;
