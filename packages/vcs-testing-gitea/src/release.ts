/**
 * The Gitea release the oracle runs: one pinned version, with the SHA-256 that
 * dl.gitea.com publishes next to each binary (`<binary>.sha256`). A binary is
 * used only when its hash matches, so bumping the version means updating both
 * the version and every hash here (and the cache key in
 * `.github/workflows/gitea-oracle.yml`).
 */
export const GITEA_VERSION = "1.22.6";

/** Published SHA-256 per Gitea platform name, for {@link GITEA_VERSION}. */
const SHA256: Record<string, string> = {
  "linux-amd64": "fd77f1a0273c85a0950207c1cfa6753a9fa57604e4ab1382484b191cc919ce15",
  "linux-arm64": "135b9946c1624f1b567373efc550cdb6d4aa1beff040c3d3ff1295f68bafd2f5",
  "darwin-10.12-amd64": "261953732fbb806dd65762a2b7223edc034dbab81df53756457499bfe99f9123",
  "darwin-10.12-arm64": "1be135efbd1e929e9893e51779646d65e0a73f84df1e8ce4d8c9661fddd8ff69",
};

export interface GiteaRelease {
  version: string;
  /** Gitea's platform name, e.g. `linux-amd64` */
  platform: string;
  /** The binary's file name in the release, e.g. `gitea-1.22.6-linux-amd64` */
  fileName: string;
  url: string;
  sha256: string;
}

/** Gitea's name for a Node `platform`/`arch` pair, or `undefined` when no binary is pinned for it. */
export function giteaPlatform(platform: string, arch: string): string | undefined {
  const cpu = arch === "x64" ? "amd64" : arch === "arm64" ? "arm64" : undefined;
  if (!cpu) return undefined;
  const name =
    platform === "linux" ? `linux-${cpu}` : platform === "darwin" ? `darwin-10.12-${cpu}` : "";
  return name in SHA256 ? name : undefined;
}

/** The pinned release for a platform (default: this process's); throws where none is pinned. */
export function giteaRelease(
  platform: string = process.platform,
  arch: string = process.arch,
): GiteaRelease {
  const name = giteaPlatform(platform, arch);
  if (!name)
    throw new Error(
      `no Gitea ${GITEA_VERSION} binary is pinned for ${platform}-${arch} ` +
        `(pinned: ${Object.keys(SHA256).join(", ")})`,
    );
  const fileName = `gitea-${GITEA_VERSION}-${name}`;
  return {
    version: GITEA_VERSION,
    platform: name,
    fileName,
    url: `https://dl.gitea.com/gitea/${GITEA_VERSION}/${fileName}`,
    sha256: SHA256[name] as string,
  };
}
