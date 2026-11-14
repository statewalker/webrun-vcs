/**
 * Packs in the object store: `withPacks` reads the installed packs (a vcs-core `PackSet`)
 * first, then the loose objects. Pack reading, writing and installing live in vcs-core.
 */

export * from "./with-packs.js";
