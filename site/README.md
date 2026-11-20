# @statewalker/vcs-site

The StateWalker VCS website: Astro, Tailwind CSS v4 and shadcn/ui tokens, built on the same
infrastructure as [cellb.dev's site](https://github.com/statewalker/cellb.dev/tree/main/site)
(components, layouts, compression, publishing). It is static; `dist/` can go to any static host.
Its live examples run the workspace's VCS packages in the visitor's browser.

```sh
pnpm install                                            # at the repository root
pnpm --filter "@statewalker/vcs-site^..." run build     # the packages it imports (exports → dist/)
pnpm --filter @statewalker/vcs-site dev                 # http://localhost:4321
pnpm --filter @statewalker/vcs-site build               # static output in site/dist/
pnpm --filter @statewalker/vcs-site check:examples      # runs every live example in Chromium
```

The packages' `exports` point at `dist/`, so build them before `dev` or `build`, and again after
changing one (the README's "What will surprise you" applies here too).

## Structure

| path | purpose |
| --- | --- |
| `src/styles/global.css` | Design tokens (shadcn/ui variable contract), light + dark: cellb.dev's structure, a Git orange |
| `src/components/ui/` | shadcn-style primitives as Astro components: Button, Badge, Card, Tabs |
| `src/components/` | Header, Footer, Logo, ThemeToggle, Icon, CodeBlock (Shiki + copy), LayerDiagram (the packages as layers) |
| `src/layouts/` | `Base` (theme bootstrap, header/footer) and `Docs` (sidebar) |
| `src/pages/` | Home, `/docs` (getting started), `/docs/architecture`, `/docs/examples` (the repository's apps and demos), `/docs/[...slug]` (the repository's Markdown), `/examples` and `/examples/<name>` (live examples), `/examples/playground` |
| `src/examples/` | The live examples: one module per example (`export default async function (out: Output)`), and `runner.ts`, the pages' client that imports and runs them |
| `src/playground/` | The playground: `repository.ts` (an in-memory working copy behind a few verbs) and `playground.ts` (the page) |
| `src/lib/docs.ts` | Which repository Markdown files become which `/docs/…` pages (the packages' READMEs, `docs/example-applications.md`) |
| `src/lib/examples.ts`, `src/lib/apps.ts` | The live examples' titles and notes; the repository's tutorials and demos |
| `scripts/check-examples.mjs` | Serves `dist/`, opens each example page in Chromium, presses Run and fails on a failed run or a page error; then drives the playground through a branch, two commits and a merge (run in `site.yml`) |
| `scripts/compress.mjs` | After `astro build`: `dist/.site/config.json` (the host's options) and Brotli/gzip copies of text assets |
| `scripts/setup-publish-secrets.sh` | Creates the publishing key and sets the repository's secrets (below) |

## Live examples

Each example is a module in `src/examples/`. Its page imports the module's text with `?raw` and
shows it, and the Run button imports the same module, so the code a visitor reads is the code
that runs. To add one: write the module, add it to `src/lib/examples.ts`, to the `modules` map in
`src/examples/runner.ts` and to `NAMES` in `scripts/check-examples.mjs`.

| Example | Shows |
| --- | --- |
| `quick-start` | The porcelain API in memory: add, commit, status, log |
| `branching-merging` | checkout -b, a commit on each side, a three-way merge |
| `object-model` | Loose objects inflated with the browser's DecompressionStream and hashed with Web Crypto: SHA-1 = id |
| `git-directory` | `vcs-store-files` over an in-memory FilesApi: the `.git` it writes, offered as a zip that native git reads (`git log`, `git fsck`) |
| `fetch-push` | upload-pack and receive-pack between two repositories over MessageChannels |

Docs: `/docs`, `/docs/architecture` and `/docs/examples` are written for the site, from the
repository README and the packages' READMEs. The package reference pages are the packages'
own README files, rendered at build time (`src/lib/docs.ts`, loaded as the `repo` collection by
`src/content.config.ts`); relative links in them are rewritten by `src/lib/rehype-repo-links.ts`
(a rendered file goes to its page, anything else to GitHub). To publish another file, add it to
`src/lib/docs.ts`, and to the `paths` filters of `.github/workflows/site.yml` if it is outside
the ones listed there.

The older Observable Framework site in `docs/` (GitHub Pages, `deploy-docs.yml`) is unchanged.

## Publishing

`.github/workflows/site.yml` builds the site on every pull request that touches it (or the
packages it bundles) and publishes it from `main` to the httpeers static-site host, as
statewalker/cellb.dev does. A site there is a first-level prefix of the `sites` bucket on
`https://s3.httpeers.net`, named after its domain; the workflow runs
`rclone sync site/dist httpeers:sites/<domain>`, inside that prefix only, and the host serves it
at once (old files for up to 60 s).

Setup, once (repository → Settings → Secrets and variables → Actions):

| Kind | Name | Value |
| --- | --- | --- |
| secret | `HTTPEERS_S3_ACCESS_KEY_ID`, `HTTPEERS_S3_SECRET_ACCESS_KEY` | credentials that can write the site's prefix in the `sites` bucket |
| variable | `SITE_DOMAIN` | optional; `vcs.httpeers.net` when unset |

Use credentials of their own, not RustFS's root pair in `/opt/httpeers/.env` on the httpeers
server, which can rewrite or delete every site in the bucket. A RustFS user whose policy allows
`s3:PutObject`, `s3:GetObject`, `s3:DeleteObject` and `s3:ListBucket` on `sites/vcs.httpeers.net/*`
only is what the workflow needs.

`site/scripts/setup-publish-secrets.sh` does all of it: it reads the root pair over ssh
(`HTTPEERS_SSH` to change the host), creates or re-keys that user (`vcs-site`) with RustFS's own
client (`rc admin`, in a `rustfs/rc` container), checks the new pair can write and delete under
`sites/<domain>/.site/`, and sets the two secrets and `SITE_DOMAIN` with `gh`. Running it again
rotates the key.

Without the secrets the workflow builds and checks the site and notes that it did not publish.
Run it by hand with "Run workflow" (`workflow_dispatch`).

`vcs.httpeers.net` needs nothing else: the zone has a wildcard DNS record and Caddy a wildcard
certificate. To move the site to a domain of its own: add a site block for it to statewalker/httpeers
`deploy/Caddyfile` (`<domain> { reverse_proxy sites:3000 }`) and deploy it, point the domain's A
(and AAAA) record at the httpeers server, set `SITE_DOMAIN`, re-run `setup-publish-secrets.sh`
with `SITE_DOMAINS` including the new name, and run the workflow.

## Style

Shared with cellb.dev's site: the shadcn token contract, Inter / JetBrains Mono, bordered cards,
grid background, mono eyebrow labels, code windows. Different: a Git orange (hue ≈ 45–55) with a
red secondary; edit `:root` / `.dark` in `src/styles/global.css` to re-skin.
