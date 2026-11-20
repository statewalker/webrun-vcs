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
 * Mermaid diagram, which this site does not render, so the architecture page links to it) and in
 * a package's own docs/ folder. */
export const guidePages: RepoPage[] = [
  {
    file: "docs/example-applications.md",
    slug: "example-applications",
    label: "Example applications",
  },
  {
    file: "packages/vcs-transport/docs/transports.md",
    slug: "transports",
    label: "Transports",
  },
];

export const repoPages = [...packagePages, ...guidePages];

export const pageHref = (page: RepoPage) => `/docs/${page.slug}`;

const hrefByFile = new Map(repoPages.map((page) => [page.file, pageHref(page)]));

/** The site page of a repository file if the site renders it, else the file on GitHub. */
export const docHref = (file: string) => hrefByFile.get(file) ?? repoFile(file);
