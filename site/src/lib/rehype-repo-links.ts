import path from "node:path";
import { docHref, repoPages } from "./docs";

interface Node {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: Node[];
}

/**
 * Rewrites the relative links of a repository Markdown file rendered on the site: a link to
 * another rendered file (or to a directory whose README.md is rendered) goes to its page; any
 * other file of the repository goes to GitHub, as the relative link would not exist on the site.
 * A link to a rendered page whose text is a file name (`[gaps.md](gaps.md)`) reads as the page's
 * title (`Gaps`): the reader of the site sees pages, not files.
 */
export function rehypeRepoLinks({ root }: { root: string }) {
  const rendered = new Set(repoPages.map((page) => page.file));
  const labels = new Map(repoPages.map((page) => [page.file, page.label]));

  /** The repository file a relative link points to, or undefined. */
  const fileOf = (from: string, href: string) => {
    if (/^([a-z][a-z0-9+.-]*:|\/|#)/i.test(href)) return undefined;
    const [target = ""] = href.split(/(?=#)/);
    const file = path.posix
      .normalize(path.posix.join(path.posix.dirname(from), target))
      .replace(/\/$/, "");
    if (file.startsWith("..")) return undefined;
    return rendered.has(`${file}/README.md`) ? `${file}/README.md` : file;
  };

  /** A link text that names a file or folder (`gaps.md`, `` `../flue` ``) rather than a page. */
  const fileText = (node: Node, href: string) => {
    const only = node.children?.length === 1 ? node.children[0] : undefined;
    const text = only?.tagName === "code" ? only.children?.[0] : only;
    const value = text?.type === "text" ? text.value?.trim() : undefined;
    const target = href.split("#")[0].replace(/\/$/, "");
    return (
      !!value &&
      (value.endsWith(".md") || value === target || value === path.posix.basename(target))
    );
  };

  return (tree: Node, vfile: { path?: string }) => {
    const from = vfile.path && path.relative(root, vfile.path).split(path.sep).join("/");
    if (!from || !rendered.has(from)) return;
    const visit = (node: Node) => {
      const href = node.tagName === "a" ? node.properties?.href : undefined;
      if (node.properties && typeof href === "string") {
        const file = fileOf(from, href);
        if (file) {
          const label = labels.get(file);
          if (label && fileText(node, href)) node.children = [{ type: "text", value: label }];
          node.properties.href = docHref(file) + (href.match(/#.*/)?.[0] ?? "");
        }
      }
      node.children?.forEach(visit);
    };
    visit(tree);
  };
}
