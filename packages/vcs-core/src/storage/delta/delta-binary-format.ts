/**
 * Delta binary format conversion
 *
 * Re-exports Git delta format functions from @statewalker/vcs-utils
 * for convenient access from the core package's delta module.
 *
 * These functions convert between format-agnostic Delta[] instructions
 * and Git's binary delta format used in pack files.
 */

import {
  deserializeDeltaFromGit as _deserializeDeltaFromGit,
  serializeDeltaToGit as _serializeDeltaToGit,
  deltaRangesToGitFormat,
  deltaToGitFormat,
  formatGitDelta,
  type GitDeltaInstruction,
  getGitDeltaBaseSize,
  getGitDeltaResultSize,
  gitFormatToDeltaRanges,
  parseGitDelta,
} from "@statewalker/vcs-utils";

// Re-export with original names
// Export with original names
// Convenience aliases for the common operations
export {
  _deserializeDeltaFromGit as deserializeDeltaFromGit,
  _deserializeDeltaFromGit as parseBinaryDelta,
  _serializeDeltaToGit as serializeDeltaToGit,
  _serializeDeltaToGit as serializeDelta,
  deltaRangesToGitFormat,
  deltaToGitFormat,
  formatGitDelta,
  type GitDeltaInstruction,
  getGitDeltaBaseSize,
  getGitDeltaResultSize,
  gitFormatToDeltaRanges,
  parseGitDelta,
};
