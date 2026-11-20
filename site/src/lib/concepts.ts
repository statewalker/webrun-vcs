/** The concept pages (src/pages/docs/concepts/<slug>.astro): what the live examples show, explained. */
export interface ConceptPage {
  slug: string;
  label: string;
  /** One line for the concepts index. */
  summary: string;
}

export const conceptPages: ConceptPage[] = [
  {
    slug: "object-model",
    label: "The object model",
    summary:
      "Blobs, trees, commits and tags; the loose object format; why an id is the SHA-1 of the bytes; packs and deltas.",
  },
  {
    slug: "branches-and-merging",
    label: "Branches, refs and merging",
    summary:
      "Refs and symbolic refs, HEAD, atomic ref updates and reflogs; checkout; fast-forward and three-way merges.",
  },
  {
    slug: "storage",
    label: "Storage and the .git layout",
    summary:
      "The storage stack from typed stores down to raw bytes; the backends; the .git directory vcs-store-files writes.",
  },
  {
    slug: "transport",
    label: "The transport",
    summary:
      "Git's wire protocol v1 and v2: upload-pack and receive-pack as state machines over HTTP or any duplex.",
  },
];

export const conceptHref = (slug: string, anchor?: string) =>
  `/docs/concepts/${slug}${anchor ? `#${anchor}` : ""}`;
