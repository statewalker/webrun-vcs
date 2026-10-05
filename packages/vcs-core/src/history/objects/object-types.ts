/**
 * Git object type codes matching JGit Constants
 */
export const ObjectType = {
  COMMIT: 1,
  TREE: 2,
  BLOB: 3,
  TAG: 4,
} as const;

export type ObjectTypeCode = (typeof ObjectType)[keyof typeof ObjectType];

/**
 * Git object type string representations
 */
export type ObjectTypeString = "commit" | "tree" | "blob" | "tag";
