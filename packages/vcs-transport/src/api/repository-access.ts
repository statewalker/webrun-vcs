/**
 * Low-level repository access interface for protocol handlers.
 *
 * Provides byte-level operations (object storage, ref management)
 * that protocol implementations (upload-pack, receive-pack) need.
 *
 * Contrast with RepositoryFacade which operates at pack-stream level.
 */

import type { ObjectId, ObjectTypeCode } from "@statewalker/vcs-core";

// Re-export core types for transport consumers
export type { ObjectId, ObjectTypeCode } from "@statewalker/vcs-core";

export interface ObjectInfo {
  type: ObjectTypeCode;
  size: number;
}

export interface RefInfo {
  name: string;
  objectId: string;
  peeledId?: string;
}

export interface HeadInfo {
  objectId?: string;
  target?: string;
}

export interface RepositoryAccess {
  hasObject(id: ObjectId): Promise<boolean>;
  getObjectInfo(id: ObjectId): Promise<ObjectInfo | null>;
  loadObject(id: ObjectId): AsyncIterable<Uint8Array>;
  storeObject(type: ObjectTypeCode, content: Uint8Array): Promise<ObjectId>;
  listRefs(): AsyncIterable<RefInfo>;
  getHead(): Promise<HeadInfo | null>;
  updateRef(name: string, oldId: ObjectId | null, newId: ObjectId | null): Promise<boolean>;
  walkObjects(
    wants: ObjectId[],
    haves: ObjectId[],
  ): AsyncIterable<{ id: ObjectId; type: ObjectTypeCode; content: Uint8Array }>;
}
