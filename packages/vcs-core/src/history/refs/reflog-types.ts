/**
 * Reflog types
 *
 * Git reflog records when the tip of branches and other references
 * were updated in the local repository.
 *
 * Reference: jgit/org.eclipse.jgit/src/org/eclipse/jgit/lib/ReflogEntry.java
 */

import type { ObjectId } from "../../common/id/index.js";
import type { PersonIdent } from "../../common/person/index.js";

/**
 * Single reflog entry
 *
 * Records a single change to a ref, including the old and new values,
 * who made the change, and a comment describing the change.
 *
 * JGit ref: org.eclipse.jgit.lib.ReflogEntry
 */
export interface ReflogEntry {
  /** SHA before the change (0000... for new refs) */
  oldId: ObjectId;
  /** SHA after the change */
  newId: ObjectId;
  /** Who made the change */
  who: PersonIdent;
  /** Reason for the change (e.g., "commit: Add feature") */
  comment: string;
}

/**
 * Reflog reader interface
 *
 * Provides read access to reflog entries for a specific ref.
 *
 * JGit ref: org.eclipse.jgit.lib.ReflogReader
 */
export interface ReflogReader {
  /** Get the most recent entry */
  getLastEntry(): Promise<ReflogEntry | undefined>;

  /** Get entries in reverse chronological order (most recent first) */
  getReverseEntries(max?: number): Promise<ReflogEntry[]>;

  /** Get specific entry by index (0 = most recent) */
  getReverseEntry(index: number): Promise<ReflogEntry | undefined>;
}

/**
 * Checkout-specific info parsed from reflog comment
 *
 * When a checkout reflog entry has a comment like
 * "checkout: moving from main to feature", this interface
 * provides parsed branch information.
 */
export interface CheckoutEntry {
  /** Branch switched from */
  fromBranch: string;
  /** Branch switched to */
  toBranch: string;
}

/**
 * Parse checkout entry from reflog comment
 *
 * @param comment Reflog comment
 * @returns Parsed checkout entry or undefined if not a checkout
 */
export function parseCheckoutEntry(comment: string): CheckoutEntry | undefined {
  const match = comment.match(/^checkout: moving from (.+) to (.+)$/);
  if (!match) return undefined;
  return {
    fromBranch: match[1],
    toBranch: match[2],
  };
}
