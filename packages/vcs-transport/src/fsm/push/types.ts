/**
 * Push command types and interfaces for Push FSM.
 */

export { ZERO_OID } from "../../protocol/constants.js";

/**
 * Type of push command being executed.
 */
export type PushCommandType =
  | "CREATE" // New ref (old = 0000...)
  | "UPDATE" // Fast-forward update
  | "UPDATE_NONFASTFORWARD" // Force push
  | "DELETE"; // Delete ref (new = 0000...)

/**
 * Result of a push command.
 */
export type PushCommandResult =
  | "NOT_ATTEMPTED"
  | "OK"
  | "REJECTED_NOCREATE" // Server doesn't allow creating refs
  | "REJECTED_NODELETE" // Server doesn't allow deleting refs
  | "REJECTED_NONFASTFORWARD" // Not a fast-forward, force not allowed
  | "REJECTED_CURRENT_BRANCH" // Cannot update checked-out branch
  | "REJECTED_MISSING_OBJECT" // Required objects not in pack
  | "REJECTED_OTHER_REASON" // Other rejection (hook, permission, etc.)
  | "LOCK_FAILURE" // Could not lock ref for update
  | "ATOMIC_REJECTED"; // Atomic push failed

/**
 * A single push command.
 */
export interface PushCommand {
  /** Current remote ref value (or 0000... for create) */
  oldOid: string;
  /** New value to set (or 0000... for delete) */
  newOid: string;
  /** Full ref name (refs/heads/main) */
  refName: string;
  /** Type of push command */
  type: PushCommandType;
  /** Result of the command */
  result: PushCommandResult;
  /** Server's rejection message */
  message?: string;
}

/**
 * Map server rejection reason to PushCommandResult.
 */
export function mapRejectReason(reason: string): PushCommandResult {
  if (reason.includes("non-fast-forward")) return "REJECTED_NONFASTFORWARD";
  if (reason.includes("current branch")) return "REJECTED_CURRENT_BRANCH";
  if (reason.includes("deny deleting")) return "REJECTED_NODELETE";
  if (reason.includes("deny creating")) return "REJECTED_NOCREATE";
  if (reason.includes("missing")) return "REJECTED_MISSING_OBJECT";
  if (reason.includes("atomic")) return "ATOMIC_REJECTED";
  if (reason.includes("lock")) return "LOCK_FAILURE";
  return "REJECTED_OTHER_REASON";
}

/**
 * Parsed refspec result.
 */
export interface ParsedRefspec {
  /** Source ref (local side), or null for delete */
  src: string | null;
  /** Destination ref (remote side) */
  dst: string;
  /** Whether this is a force push (+) */
  force: boolean;
}

/**
 * Parse a refspec string into its components.
 *
 * Formats:
 * - "src:dst" — push src to dst
 * - "+src:dst" — force push src to dst
 * - "ref" — push ref to same name
 * - ":dst" — delete dst
 *
 * @param refspec - Refspec string to parse
 * @returns Parsed refspec
 */
export function parseRefspec(refspec: string): ParsedRefspec {
  let spec = refspec;
  let force = false;

  if (spec.startsWith("+")) {
    force = true;
    spec = spec.slice(1);
  }

  const colonIdx = spec.indexOf(":");
  if (colonIdx < 0) {
    return { src: spec, dst: spec, force };
  }

  const src = spec.slice(0, colonIdx);
  const dst = spec.slice(colonIdx + 1);

  return { src: src || null, dst, force };
}
