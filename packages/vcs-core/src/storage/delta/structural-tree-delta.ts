/**
 * Structural Tree Delta - Compute and apply entry-level tree diffs
 *
 * For SQL/KV/memory backends that store trees in normalized form.
 * Instead of byte-level binary diffs, computes semantic changes:
 * add, modify, delete of individual tree entries.
 */

import type { TreeEntry } from "../../history/trees/tree-entry.js";
import type { StructuralTreeDelta, TreeDeltaChange } from "./tree-delta-api.js";

/**
 * Compute structural delta between two sorted tree entry arrays.
 *
 * Both arrays must be sorted by entry name (Git tree ordering).
 * Returns the minimal set of changes to transform base into target.
 *
 * @param baseEntries Sorted entries of the base tree
 * @param targetEntries Sorted entries of the target tree
 * @returns Array of changes (add/modify/delete)
 */
export function computeStructuralTreeDelta(
  baseEntries: TreeEntry[],
  targetEntries: TreeEntry[],
): TreeDeltaChange[] {
  const changes: TreeDeltaChange[] = [];

  // Build lookup from base entries
  const baseMap = new Map<string, TreeEntry>();
  for (const entry of baseEntries) {
    baseMap.set(entry.name, entry);
  }

  const seen = new Set<string>();

  // Walk target entries: detect adds and modifies
  for (const target of targetEntries) {
    seen.add(target.name);
    const base = baseMap.get(target.name);

    if (!base) {
      // Entry exists in target but not in base — added
      changes.push({
        type: "add",
        name: target.name,
        mode: target.mode,
        objectId: target.id,
      });
    } else if (base.id !== target.id || base.mode !== target.mode) {
      // Entry exists in both but differs — modified
      changes.push({
        type: "modify",
        name: target.name,
        mode: target.mode,
        objectId: target.id,
      });
    }
    // else: identical entry, no change
  }

  // Walk base entries: detect deletes
  for (const base of baseEntries) {
    if (!seen.has(base.name)) {
      changes.push({
        type: "delete",
        name: base.name,
      });
    }
  }

  return changes;
}

/**
 * Apply structural delta changes to base entries to reconstruct target.
 *
 * @param baseEntries Sorted entries of the base tree
 * @param changes Delta changes to apply
 * @returns Sorted entries of the reconstructed target tree
 */
export function applyStructuralTreeDelta(
  baseEntries: TreeEntry[],
  changes: TreeDeltaChange[],
): TreeEntry[] {
  // Build mutable map from base
  const entryMap = new Map<string, TreeEntry>();
  for (const entry of baseEntries) {
    entryMap.set(entry.name, entry);
  }

  // Apply changes
  for (const change of changes) {
    switch (change.type) {
      case "add":
      case "modify":
        entryMap.set(change.name, {
          name: change.name,
          mode: change.mode!,
          id: change.objectId!,
        });
        break;
      case "delete":
        entryMap.delete(change.name);
        break;
    }
  }

  // Return sorted by name (Git tree ordering)
  return Array.from(entryMap.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Serialize a structural tree delta to a compact binary format.
 *
 * Format:
 *   [4 bytes] base tree ID length (big-endian uint32)
 *   [N bytes] base tree ID (UTF-8)
 *   [4 bytes] number of changes (big-endian uint32)
 *   For each change:
 *     [1 byte]  change type (0=add, 1=modify, 2=delete)
 *     [2 bytes] name length (big-endian uint16)
 *     [N bytes] name (UTF-8)
 *     If add or modify:
 *       [4 bytes] mode (big-endian uint32)
 *       [2 bytes] objectId length (big-endian uint16)
 *       [N bytes] objectId (UTF-8)
 */
export function serializeStructuralDelta(delta: StructuralTreeDelta): Uint8Array {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];

  // Base tree ID
  const baseIdBytes = encoder.encode(delta.baseTreeId);
  const baseIdHeader = new Uint8Array(4);
  new DataView(baseIdHeader.buffer).setUint32(0, baseIdBytes.length, false);
  parts.push(baseIdHeader, baseIdBytes);

  // Number of changes
  const countHeader = new Uint8Array(4);
  new DataView(countHeader.buffer).setUint32(0, delta.changes.length, false);
  parts.push(countHeader);

  // Each change
  for (const change of delta.changes) {
    const typeMap = { add: 0, modify: 1, delete: 2 } as const;
    parts.push(new Uint8Array([typeMap[change.type]]));

    const nameBytes = encoder.encode(change.name);
    const nameHeader = new Uint8Array(2);
    new DataView(nameHeader.buffer).setUint16(0, nameBytes.length, false);
    parts.push(nameHeader, nameBytes);

    if (change.type === "add" || change.type === "modify") {
      const modeBytes = new Uint8Array(4);
      new DataView(modeBytes.buffer).setUint32(0, change.mode ?? 0, false);
      parts.push(modeBytes);

      const oidBytes = encoder.encode(change.objectId ?? "");
      const oidHeader = new Uint8Array(2);
      new DataView(oidHeader.buffer).setUint16(0, oidBytes.length, false);
      parts.push(oidHeader, oidBytes);
    }
  }

  // Concatenate all parts
  const totalLength = parts.reduce((sum, p) => sum + p.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

/**
 * Parse a serialized structural tree delta.
 *
 * @param data Binary data from serializeStructuralDelta
 * @returns Parsed StructuralTreeDelta
 */
export function parseStructuralDelta(data: Uint8Array): StructuralTreeDelta {
  const decoder = new TextDecoder();
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let pos = 0;

  // Base tree ID
  const baseIdLen = view.getUint32(pos, false);
  pos += 4;
  const baseTreeId = decoder.decode(data.subarray(pos, pos + baseIdLen));
  pos += baseIdLen;

  // Number of changes
  const changeCount = view.getUint32(pos, false);
  pos += 4;

  const typeNames = ["add", "modify", "delete"] as const;
  const changes: TreeDeltaChange[] = [];

  for (let i = 0; i < changeCount; i++) {
    const typeCode = data[pos];
    pos += 1;
    const type = typeNames[typeCode];

    const nameLen = view.getUint16(pos, false);
    pos += 2;
    const name = decoder.decode(data.subarray(pos, pos + nameLen));
    pos += nameLen;

    if (type === "add" || type === "modify") {
      const mode = view.getUint32(pos, false);
      pos += 4;

      const oidLen = view.getUint16(pos, false);
      pos += 2;
      const objectId = decoder.decode(data.subarray(pos, pos + oidLen));
      pos += oidLen;

      changes.push({ type, name, mode, objectId });
    } else {
      changes.push({ type, name });
    }
  }

  return { baseTreeId, changes };
}
