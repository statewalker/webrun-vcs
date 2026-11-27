/**
 * How many tags the ref filter peels through before it gives up. git's own peeling has no
 * bound, so a tag cycle made through replace refs (tag A replaced by tag B, which names A)
 * makes native `--points-at`, `--contains` and `%(*atom)` loop forever; ours stops here and
 * treats the chain as reaching nothing (statewalker/webrun-vcs#263).
 */
export const MAX_REF_FILTER_PEEL_DEPTH = 1000;
