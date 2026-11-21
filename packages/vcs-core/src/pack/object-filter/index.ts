/**
 * Partial clone filters (`--filter=<spec>`): parsing as git's list-objects-filter-options.c,
 * and the filters of list-objects-filter.c that `listObjects` asks while it walks.
 */

export * from "./filter-runtime.js";
export * from "./object-filter.js";
