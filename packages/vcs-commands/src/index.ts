// Main entry point

// Fluent API commands
export * from "./commands/index.js";

// Note: Core command implementations (Add, Checkout interfaces and their impl classes)
// are available via direct import from "./core-commands/" to avoid naming conflicts
// with the fluent API. Example: import { AddCommand } from "@statewalker/vcs-commands/core-commands";
// Errors
export * from "./errors/index.js";
export { Git } from "./git.js";
// Base classes
export { GitCommand } from "./git-command.js";
// Results
export * from "./results/index.js";
export { TransportCommand } from "./transport-command.js";
// Types
export * from "./types.js";
