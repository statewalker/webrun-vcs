/**
 * Pack file management (file-dependent implementations)
 *
 * Contains PackDirectory, PackReader, PackDeltaStore, and related
 * classes that depend on FilesApi for file I/O.
 *
 * Pack binary format codecs remain in @statewalker/vcs-core.
 */

export * from "./git-pack-store.impl.js";
export * from "./pack-consolidator.js";
export * from "./pack-delta-store.js";
export * from "./pack-directory.js";
export * from "./pack-reader.js";
export * from "./random-access-delta-reader.js";
