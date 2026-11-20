import { repoFile } from "./site";

/** A Markdown file of the repository that the site renders at /docs/<slug>. */
export interface RepoPage {
  /** Path from the repository root. */
  file: string;
  slug: string;
  label: string;
  /** The npm package the page documents, if any. */
  npm?: string;
}

const pkg = (name: string, label: string): RepoPage => ({
  file: `packages/${name}/README.md`,
  slug: `packages/${name}`,
  label,
  npm: `@statewalker/${name}`,
});

/** The public packages' READMEs, in the order of the layers (bottom first). */
export const packagePages: RepoPage[] = [
  pkg("vcs-utils", "vcs-utils"),
  pkg("vcs-utils-node", "vcs-utils-node"),
  pkg("vcs-core", "vcs-core"),
  pkg("vcs-working-tree", "vcs-working-tree"),
  pkg("vcs-store-mem", "vcs-store-mem"),
  pkg("vcs-store-files", "vcs-store-files"),
  pkg("vcs-store-sql", "vcs-store-sql"),
  pkg("vcs-store-kv", "vcs-store-kv"),
  pkg("vcs-transport", "vcs-transport"),
  pkg("vcs-transport-adapters", "vcs-transport-adapters"),
  pkg("vcs-transport-lfs", "vcs-transport-lfs"),
  pkg("vcs-transport-xet", "vcs-transport-xet"),
  pkg("vcs-transport-httpeers", "vcs-transport-httpeers"),
  pkg("vcs-commands", "vcs-commands"),
  pkg("vcs-workspace", "vcs-workspace"),
];

/** Guides kept in docs/ (Markdown beside the Observable site; package-dependencies.md is a
 * Mermaid diagram, which this site does not render, so the architecture page links to it). */
export const guidePages: RepoPage[] = [
  {
    file: "docs/example-applications.md",
    slug: "example-applications",
    label: "Example applications",
  },
];

export const repoPages = [...packagePages, ...guidePages];

export const pageHref = (page: RepoPage) => `/docs/${page.slug}`;

const hrefByFile = new Map(repoPages.map((page) => [page.file, pageHref(page)]));

/** The site page of a repository file if the site renders it, else the file on GitHub. */
export const docHref = (file: string) => hrefByFile.get(file) ?? repoFile(file);

/** The explanation sections of /docs/concepts and /docs/architecture each package implements:
 * listed under the package's page with the live examples that import it. */
export const packageConcepts: Record<string, { label: string; href: string }[]> = {
  "@statewalker/vcs-core": [
    { label: "The object model", href: "/docs/concepts#objects" },
    { label: "Loose objects and ids", href: "/docs/concepts#loose-objects" },
    { label: "Pack files", href: "/docs/concepts#packs" },
    { label: "Refs, HEAD and branches", href: "/docs/concepts#refs" },
  ],
  "@statewalker/vcs-working-tree": [
    { label: "History, checkout and worktree", href: "/docs/concepts#working-copy" },
  ],
  "@statewalker/vcs-commands": [
    { label: "History, checkout and worktree", href: "/docs/concepts#working-copy" },
    { label: "Merging", href: "/docs/concepts#merge" },
  ],
  "@statewalker/vcs-store-files": [
    { label: "The .git directory", href: "/docs/concepts#git-directory" },
    { label: "Storage is a set of small interfaces", href: "/docs/architecture#storage" },
  ],
  "@statewalker/vcs-store-mem": [
    { label: "Storage is a set of small interfaces", href: "/docs/architecture#storage" },
  ],
  "@statewalker/vcs-store-sql": [
    { label: "Storage is a set of small interfaces", href: "/docs/architecture#storage" },
  ],
  "@statewalker/vcs-store-kv": [
    { label: "Storage is a set of small interfaces", href: "/docs/architecture#storage" },
  ],
  "@statewalker/vcs-transport": [
    { label: "The wire protocol", href: "/docs/concepts#transport" },
    { label: "Fetch negotiation", href: "/docs/concepts#negotiation" },
    { label: "One transport for servers and peers", href: "/docs/architecture#transport" },
  ],
  "@statewalker/vcs-transport-adapters": [
    { label: "One transport for servers and peers", href: "/docs/architecture#transport" },
  ],
  "@statewalker/vcs-transport-httpeers": [
    { label: "One transport for servers and peers", href: "/docs/architecture#transport" },
  ],
  "@statewalker/vcs-transport-lfs": [
    { label: "Large objects go around the object store", href: "/docs/architecture#large-objects" },
  ],
  "@statewalker/vcs-transport-xet": [
    { label: "Large objects go around the object store", href: "/docs/architecture#large-objects" },
  ],
  "@statewalker/vcs-workspace": [
    { label: "File sync and versioning stay independent", href: "/docs/architecture#workspace" },
  ],
  "@statewalker/vcs-utils": [
    { label: "Portable by construction", href: "/docs/architecture#portability" },
  ],
  "@statewalker/vcs-utils-node": [
    { label: "Portable by construction", href: "/docs/architecture#portability" },
  ],
};
