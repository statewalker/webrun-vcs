export const REPO = "https://github.com/statewalker/webrun-vcs";
/** Links into the repository's default branch. */
export const repoFile = (path: string) => `${REPO}/blob/HEAD/${path}`;
/** Links to a directory of the repository's default branch. */
export const repoTree = (path: string) => `${REPO}/tree/HEAD/${path}`;
export const npmPackage = (name: string) => `https://www.npmjs.com/package/${name}`;
/** The one-page summary built from docs/ with Observable Framework, on GitHub Pages. */
export const OBSERVABLE_DOCS = "https://statewalker.github.io/webrun-vcs/";
