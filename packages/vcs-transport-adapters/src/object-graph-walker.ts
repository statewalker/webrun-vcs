/**
 * Object graph walker for pack generation.
 *
 * Traverses the Git object graph from starting points (wants) to generate
 * the set of objects needed for pack files during fetch/clone operations.
 *
 * Algorithm:
 * 1. Start from 'wants' (objects client needs)
 * 2. Traverse commit → tree → blob/subtree graph
 * 3. Stop traversal when reaching 'haves' (objects client has)
 * 4. Yield each object exactly once (dedup via Set)
 */

import {
  type GitObjectStore,
  type ObjectId,
  ObjectType,
  type ObjectTypeCode,
  parseCommit,
  parseTree,
} from "@statewalker/vcs-core";
import { collect } from "@statewalker/vcs-utils/streams";

/**
 * Object graph walker interface.
 *
 * Walks the object graph from starting points, yielding objects
 * that need to be included in a pack file.
 */
export interface ObjectGraphWalker {
  /**
   * Walk the object graph from wants to haves.
   *
   * @param wants - Object IDs the client wants (starting points)
   * @param haves - Object IDs the client already has (stop points)
   * @yields Objects in the graph, each exactly once
   */
  walk(
    wants: ObjectId[],
    haves: ObjectId[],
  ): AsyncIterable<{ id: ObjectId; type: ObjectTypeCode; content: Uint8Array }>;
}

/**
 * Map from type string to type code.
 */
const TYPE_STRING_TO_CODE: Record<string, ObjectTypeCode> = {
  commit: ObjectType.COMMIT,
  tree: ObjectType.TREE,
  blob: ObjectType.BLOB,
  tag: ObjectType.TAG,
};

/**
 * Create an object graph walker for a GitObjectStore.
 *
 * @param objectStore - The object store to walk
 * @returns ObjectGraphWalker instance
 */
export function createObjectGraphWalker(objectStore: GitObjectStore): ObjectGraphWalker {
  return {
    async *walk(
      wants: ObjectId[],
      haves: ObjectId[],
    ): AsyncIterable<{ id: ObjectId; type: ObjectTypeCode; content: Uint8Array }> {
      const haveSet = new Set(haves);
      const seen = new Set<ObjectId>();

      // Process wants in order
      for (const wantId of wants) {
        yield* walkObject(wantId, objectStore, haveSet, seen);
      }
    },
  };
}

/**
 * Walk a single object and its dependencies.
 */
async function* walkObject(
  id: ObjectId,
  objectStore: GitObjectStore,
  haves: Set<ObjectId>,
  seen: Set<ObjectId>,
): AsyncGenerator<{ id: ObjectId; type: ObjectTypeCode; content: Uint8Array }> {
  // Skip if already seen or client has it
  if (seen.has(id) || haves.has(id)) {
    return;
  }
  seen.add(id);

  // Check if object exists
  const exists = await objectStore.has(id);
  if (!exists) {
    throw new Error(`Object not found: ${id}`);
  }

  // Load object with header
  const [header, contentStream] = await objectStore.loadWithHeader(id);
  const content = await collect(contentStream);
  const typeCode = TYPE_STRING_TO_CODE[header.type];

  if (typeCode === undefined) {
    throw new Error(`Unknown object type: ${header.type}`);
  }

  // Yield the object
  yield { id, type: typeCode, content };

  // Walk dependencies based on type
  switch (typeCode) {
    case ObjectType.COMMIT:
      yield* walkCommit(id, content, objectStore, haves, seen);
      break;

    case ObjectType.TREE:
      yield* walkTree(content, objectStore, haves, seen);
      break;

    case ObjectType.TAG:
      yield* walkTag(content, objectStore, haves, seen);
      break;

    // Blobs have no dependencies
  }
}

/**
 * Walk a commit object's dependencies.
 */
async function* walkCommit(
  _id: ObjectId,
  content: Uint8Array,
  objectStore: GitObjectStore,
  haves: Set<ObjectId>,
  seen: Set<ObjectId>,
): AsyncGenerator<{ id: ObjectId; type: ObjectTypeCode; content: Uint8Array }> {
  try {
    const commit = parseCommit(content);

    // Walk tree first
    yield* walkObject(commit.tree, objectStore, haves, seen);

    // Walk parents (stop at haves boundary)
    for (const parent of commit.parents) {
      yield* walkObject(parent, objectStore, haves, seen);
    }
  } catch (error) {
    // If we can't parse the commit, just skip its dependencies
    // The object itself was already yielded
    console.warn(`Failed to parse commit: ${error}`);
  }
}

/**
 * Walk a tree object's dependencies.
 */
async function* walkTree(
  content: Uint8Array,
  objectStore: GitObjectStore,
  haves: Set<ObjectId>,
  seen: Set<ObjectId>,
): AsyncGenerator<{ id: ObjectId; type: ObjectTypeCode; content: Uint8Array }> {
  try {
    for (const entry of parseTree(content)) {
      yield* walkObject(entry.id, objectStore, haves, seen);
    }
  } catch (error) {
    // If we can't parse the tree, just skip its dependencies
    console.warn(`Failed to parse tree: ${error}`);
  }
}

/**
 * Walk a tag object's dependencies.
 */
async function* walkTag(
  content: Uint8Array,
  objectStore: GitObjectStore,
  haves: Set<ObjectId>,
  seen: Set<ObjectId>,
): AsyncGenerator<{ id: ObjectId; type: ObjectTypeCode; content: Uint8Array }> {
  try {
    // Parse tag to find target object
    const targetId = parseTagTarget(content);
    if (targetId) {
      yield* walkObject(targetId, objectStore, haves, seen);
    }
  } catch (error) {
    // If we can't parse the tag, just skip its dependencies
    console.warn(`Failed to parse tag: ${error}`);
  }
}

/**
 * Parse a tag object to extract the target object ID.
 *
 * Tag format:
 *   object <sha1>
 *   type <type>
 *   tag <tagname>
 *   tagger <ident>
 *
 *   <message>
 */
function parseTagTarget(content: Uint8Array): ObjectId | null {
  const decoder = new TextDecoder();
  const text = decoder.decode(content);
  const lines = text.split("\n");

  for (const line of lines) {
    if (line === "") {
      // End of headers
      break;
    }
    if (line.startsWith("object ")) {
      return line.substring(7).trim();
    }
  }

  return null;
}
