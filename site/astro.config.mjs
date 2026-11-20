// @ts-check

import { fileURLToPath } from "node:url";
import { unified } from "@astrojs/markdown-remark";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "astro/config";
import { rehypeRepoLinks } from "./src/lib/rehype-repo-links.ts";

export default defineConfig({
  site: "https://vcs.statewalker.com",
  vite: {
    plugins: [tailwindcss()],
    // The live examples bundle vcs-commands, about 1.4 MB unminified (under 400 KB as Brotli):
    // a chunk that size is expected, not a warning.
    build: { chunkSizeWarningLimit: 1600 },
  },
  markdown: {
    // The theme CodeBlock uses, so code reads the same in Markdown pages and hand-written ones.
    shikiConfig: { theme: "github-dark-default" },
    // The unified processor, not Astro's default, because the repository's Markdown needs its
    // relative links rewritten for the site (rehypeRepoLinks).
    processor: unified({
      rehypePlugins: [[rehypeRepoLinks, { root: fileURLToPath(new URL("..", import.meta.url)) }]],
    }),
  },
});
