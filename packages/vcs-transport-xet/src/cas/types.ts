/**
 * Shapes shared by the Hub and CAS read clients.
 */

/** the `fetch` the clients call (injectable: a test double, a proxy, a handler) */
export type XetFetch = (input: string, init?: RequestInit) => Promise<Response>;

export type RepoType = "model" | "dataset" | "space";

/** a Hub repository and how to reach it */
export interface RepoRef {
  /** `owner/name` */
  repo: string;
  /** default "model" */
  repoType?: RepoType;
  /** a branch, tag or commit; default "main" */
  revision?: string;
  /** default https://huggingface.co */
  hubUrl?: string;
  /** a Hub token for private repositories (not needed for public ones) */
  token?: string;
  fetch?: XetFetch;
}

/** a CAS access token, as the Hub's `xet-read-token` endpoint answers */
export interface XetToken {
  /** the CAS server's base URL */
  casUrl: string;
  accessToken: string;
  /** expiry, seconds since the epoch (0 or absent: unknown) */
  exp: number;
}

/** a file of a repository as the Hub's `paths-info` describes it */
export interface HubFile {
  path: string;
  size: number;
  /** the Xet file hash (absent for a file not stored with Xet) */
  xetHash?: string;
  /** the file's SHA-256 (the LFS object id), hex */
  sha256?: string;
}

/** an HTTP answer that is not the one asked for */
export class XetHttpError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "XetHttpError";
  }
}
