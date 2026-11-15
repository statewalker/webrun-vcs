/**
 * @statewalker/vcs-transport-httpeers
 *
 * git smart HTTP and Git LFS between peers of an httpeers mesh. A serving peer puts the git
 * server of `@statewalker/vcs-transport` and the LFS server of `@statewalker/vcs-transport-lfs`
 * behind httpeers' access middleware (Biscuit membership tokens bound to the peer the transport
 * proved, capabilities from mesh roles, per-ref push authorization); a calling peer runs the git
 * and LFS clients over a peer connection (Fetch exchanges over a webrun `Duplex`), and downloads
 * LFS objects from several peers at once.
 */

export * from "./access/index.js";
export * from "./git/index.js";
export * from "./lfs/index.js";
export * from "./peer/index.js";
