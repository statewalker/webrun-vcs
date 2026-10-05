/**
 * Node.js-specific utilities for @statewalker/vcs-utils
 *
 * This package provides optimized Node.js implementations that can be
 * explicitly registered with the main vcs-utils package.
 *
 * @example
 * ```ts
 * import { setCompressionUtils } from "@statewalker/vcs-utils/compression";
 * import { createNodeCompression } from "@statewalker/vcs-utils-node/compression";
 *
 * // Explicitly opt-in to Node.js optimizations
 * setCompressionUtils(createNodeCompression());
 * ```
 *
 * @packageDocumentation
 */

export * from "./compression/index.js";
export * from "./files/index.js";
