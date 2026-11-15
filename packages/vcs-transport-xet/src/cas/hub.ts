/**
 * The Hub side of a Xet read: a file's Xet hash (`paths-info`) and a CAS read token
 * (`xet-read-token`).
 */

import { type HubFile, type RepoRef, XetHttpError, type XetToken } from "./types.js";

const apiBase = (r: RepoRef) => {
  const type = r.repoType ?? "model";
  const kind = type === "model" ? "models" : `${type}s`;
  return `${r.hubUrl ?? "https://huggingface.co"}/api/${kind}/${r.repo}`;
};

export const bearer = (token?: string): Record<string, string> =>
  token ? { authorization: `Bearer ${token}` } : {};

/** cancels a body nobody reads, so its connection is released */
export async function discard(res: Response): Promise<void> {
  await res.body?.cancel().catch(() => {});
}

export async function readJson<T>(res: Response, what: string): Promise<T> {
  if (!res.ok) {
    await discard(res);
    throw new XetHttpError(`${what}: HTTP ${res.status}`, res.status);
  }
  return (await res.json()) as T;
}

/**
 * A file's Xet hash and SHA-256 from the Hub's `paths-info` (the `resolve` endpoint gives them
 * too, but in a redirect a browser cannot read).
 */
export async function hubPathInfo(
  r: RepoRef,
  path: string,
  o: { signal?: AbortSignal } = {},
): Promise<HubFile> {
  const f = r.fetch ?? fetch;
  const res = await f(`${apiBase(r)}/paths-info/${encodeURIComponent(r.revision ?? "main")}`, {
    method: "POST",
    signal: o.signal,
    headers: { "content-type": "application/json", ...bearer(r.token) },
    body: JSON.stringify({ paths: [path], expand: false }),
  });
  const rows = await readJson<
    { path: string; type: string; size: number; xetHash?: string; lfs?: { oid: string } }[]
  >(res, `paths-info ${path}`);
  const row = rows.find((x) => x.path === path && x.type === "file");
  if (!row) throw new XetHttpError(`${path}: no such file`);
  return { path: row.path, size: row.size, xetHash: row.xetHash, sha256: row.lfs?.oid };
}

/**
 * A CAS read token from `GET /api/{models|datasets|spaces}/{repo}/xet-read-token/{revision}`:
 * anonymous for public repositories, with the Hub token for private ones.
 */
export async function xetReadToken(
  r: RepoRef,
  o: { signal?: AbortSignal } = {},
): Promise<XetToken> {
  const f = r.fetch ?? fetch;
  const res = await f(`${apiBase(r)}/xet-read-token/${encodeURIComponent(r.revision ?? "main")}`, {
    headers: bearer(r.token),
    signal: o.signal,
  });
  return readJson<XetToken>(res, "xet-read-token");
}
