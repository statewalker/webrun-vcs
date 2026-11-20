import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { repoPages } from "./lib/docs";

export const collections = {
  // The repository's own Markdown, rendered as site pages; ids are paths from the repository root.
  repo: defineCollection({
    loader: glob({
      base: "..",
      pattern: repoPages.map((page) => page.file),
      generateId: ({ entry }) => entry,
    }),
  }),
};
