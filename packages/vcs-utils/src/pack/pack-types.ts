/**
 * Pack object type utilities
 *
 * Converts between numeric pack object types and string names.
 * Shared between pack-entries-parser, pack-indexer, and transport.
 */

/** Git object type as string */
export type GitObjectType = "commit" | "tree" | "blob" | "tag";

/**
 * Convert pack object type number to string name.
 *
 * Only converts base types (1-4). Delta types (6, 7) are not
 * representable as Git object types.
 *
 * @param type Pack object type number (1=commit, 2=tree, 3=blob, 4=tag)
 * @returns Git object type string
 */
export function packTypeToString(type: number): GitObjectType {
  switch (type) {
    case 1:
      return "commit";
    case 2:
      return "tree";
    case 3:
      return "blob";
    case 4:
      return "tag";
    default:
      throw new Error(`Unknown object type: ${type}`);
  }
}
