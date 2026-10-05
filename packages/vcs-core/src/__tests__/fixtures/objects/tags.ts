import type { PersonIdent } from "../../../common/person/person-ident.js";

/**
 * Test tag fixtures.
 */
export const TAG_FIXTURES = {
  /**
   * Lightweight tag (reference only, not an object)
   * Note: Lightweight tags are just refs, not tag objects
   */
  lightweight: {
    ref: "refs/tags/v1.0.0",
    target: "placeholder-commit-hash",
  },

  /**
   * Annotated tag pointing to a commit
   */
  annotated: {
    object: "placeholder-commit-hash",
    type: "commit" as const,
    tag: "v1.0.0",
    tagger: {
      name: "Test Tagger",
      email: "tagger@test.com",
      timestamp: 1700010000,
      tzOffset: "+0000",
    } as PersonIdent,
    message: "Release version 1.0.0\n",
    hash: "computed",
  },

  /**
   * Annotated tag with multiline message
   */
  annotatedWithMessage: {
    object: "placeholder-commit-hash",
    type: "commit" as const,
    tag: "v2.0.0",
    tagger: {
      name: "Test Tagger",
      email: "tagger@test.com",
      timestamp: 1700020000,
      tzOffset: "+0000",
    } as PersonIdent,
    message: "Release version 2.0.0\n\nThis is a major release with breaking changes.\n",
    hash: "computed",
  },

  /**
   * Tag pointing to a blob
   */
  blobTag: {
    object: "placeholder-blob-hash",
    type: "blob" as const,
    tag: "important-file",
    tagger: {
      name: "Test Tagger",
      email: "tagger@test.com",
      timestamp: 1700030000,
      tzOffset: "+0000",
    } as PersonIdent,
    message: "Important file snapshot\n",
    hash: "computed",
  },

  /**
   * Tag pointing to a tree
   */
  treeTag: {
    object: "placeholder-tree-hash",
    type: "tree" as const,
    tag: "snapshot",
    tagger: {
      name: "Test Tagger",
      email: "tagger@test.com",
      timestamp: 1700040000,
      tzOffset: "+0000",
    } as PersonIdent,
    message: "Tree snapshot\n",
    hash: "computed",
  },
} as const;
