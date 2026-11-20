export const REPO = "https://github.com/statewalker/webrun-vcs";
/** Links into the repository's default branch. */
export const repoFile = (path: string) => `${REPO}/blob/HEAD/${path}`;
/** Links to a directory of the repository's default branch. */
export const repoTree = (path: string) => `${REPO}/tree/HEAD/${path}`;
export const npmPackage = (name: string) => `https://www.npmjs.com/package/${name}`;
/** The earlier one-page summary (docs/, Observable Framework, on GitHub Pages); this site supersedes it. */
export const OBSERVABLE_DOCS = "https://statewalker.github.io/webrun-vcs/";
