/**
 * Format types for Git object serialization
 */

import type { PersonIdent } from "../../common/person/person-ident.js";
import type { ObjectTypeCode } from "../objects/object-types.js";

/**
 * Commit entry types for streaming commit parsing/serialization
 */
export type CommitEntry =
  | { type: "tree"; value: string }
  | { type: "parent"; value: string }
  | { type: "author"; value: PersonIdent }
  | { type: "committer"; value: PersonIdent }
  | { type: "encoding"; value: string }
  | { type: "gpgsig"; value: string }
  | { type: "message"; value: string };

/**
 * Tag entry types for streaming tag parsing/serialization
 */
export type TagEntry =
  | { type: "object"; value: string }
  | { type: "objectType"; value: ObjectTypeCode }
  | { type: "tag"; value: string }
  | { type: "tagger"; value: PersonIdent }
  | { type: "encoding"; value: string }
  | { type: "gpgsig"; value: string }
  | { type: "message"; value: string };
