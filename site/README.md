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
pnpm --filter @statewalker/vcs-site check:links         # every internal link and #anchor of dist/ resolves
pnpm --filter @statewalker/vcs-site check:examples      # runs every live example in Chromium
```

The packages' `exports` point at `dist/`, so build them before `dev` or `build`, and again after
changing one (the README's "What will surprise you" applies here too).

## Structure

| path | purpose |
| --- | --- |
| `src/styles/global.css` | Design tokens (shadcn/ui variable contract), light + dark: cellb.dev's structure, a Git orange |
| `src/components/ui/` | shadcn-style primitives as Astro components: `button`, `badge`, `card`, `tabs` |
| `src/components/` | `header`, `footer`, `logo`, `theme-toggle`, `icon`, `code-block` (Shiki + copy), `layer-diagram` (the packages as layers); file names are kebab-case, as the repository's CLAUDE.md asks |
| `src/layouts/` | `base` (theme bootstrap, header/footer) and `docs` (sidebar) |
| `src/pages/` | Home, `/docs` (getting started), `/docs/architecture`, `/docs/concepts` (how Git works here: the concepts the examples show), `/docs/examples` (the repository's apps and demos), `/docs/[...slug]` (the repository's Markdown), `/examples` and `/examples/<name>` (live examples), `/examples/playground` |
| `src/examples/` | The live examples: one module per example (`export default async function (out: Output)`), and `runner.ts`, the pages' client that imports and runs them |
| `src/playground/` | The playground: `repository.ts` (an in-memory working copy behind a few verbs) and `playground.ts` (the page) |
| `src/lib/docs.ts` | Which repository Markdown files become which `/docs/…` pages (the packages' READMEs, `docs/example-applications.md`) |
| `src/lib/examples.ts`, `src/lib/apps.ts` | The live examples' titles, notes and concept links; the repository's tutorials and demos |
| `scripts/check-links.mjs` | Walks `dist/` and fails on an internal link or `#anchor` that does not resolve (run in `site.yml`) |
| `scripts/check-examples.mjs` | Serves `dist/`, opens each example page in Chromium, presses Run and fails on a failed run or a page error; then drives the playground through a branch, two commits and a merge (run in `site.yml`) |
| `scripts/compress.mjs` | After `astro build`: `dist/.site/config.json` (the host's options) and Brotli/gzip copies of text assets |
| `scripts/setup-publish-secrets.sh` | Creates the publishing key and sets the repository's secrets (below) |

## Live examples

Each example is a module in `src/examples/`. Its page imports the module's text with `?raw` and
shows it, and the Run button imports the same module, so the code a visitor reads is the code
that runs. To add one: write the module, add it to `src/lib/examples.ts` (with its `concepts`: the pages
and sections that explain what it shows), to the `modules` map in
`src/examples/runner.ts` and to `NAMES` in `scripts/check-examples.mjs`.

| Example | Shows |
| --- | --- |
| `quick-start` | The porcelain API in memory: add, commit, status, log |
| `branching-merging` | checkout -b, a commit on each side, a three-way merge |
| `object-model` | Loose objects inflated with the browser's DecompressionStream and hashed with Web Crypto: SHA-1 = id |
| `git-directory` | `vcs-store-files` over an in-memory FilesApi: the `.git` it writes, offered as a zip that native git reads (`git log`, `git fsck`) |
| `fetch-push` | upload-pack and receive-pack between two repositories over MessageChannels |

Docs: `/docs`, `/docs/architecture`, `/docs/concepts` and `/docs/examples` are written for the site, from the
repository README and the packages' READMEs. The package reference pages are the packages'
own README files, rendered at build time, each followed by the concepts and live examples that
involve it (`packageConcepts` in `src/lib/docs.ts`). `src/lib/docs.ts` lists the files, loaded as
the `repo` collection by `src/content.config.ts`; relative links in them are rewritten by `src/lib/rehype-repo-links.ts`
(a rendered file goes to its page, anything else to GitHub). To publish another file, add it to
`src/lib/docs.ts`, and to the `paths` filters of `.github/workflows/site.yml` if it is outside
the ones listed there.

The one-page Observable Framework summary in `docs/` (GitHub Pages, `deploy-docs.yml`) is
unchanged; this site covers everything it says and links to it from Getting started. Retiring it
is a separate decision.

## Publishing

`.github/workflows/site.yml` builds the site on every pull request that touches it (or the
packages it bundles), checks every internal link (`check:links`) and runs every live example in
Chromium (`check:examples`). From `main` it then publishes to the httpeers static-site host, as
statewalker/cellb.dev does. A site there is a first-level prefix of the `sites` bucket on
`https://s3.httpeers.net`, named after its domain; the workflow runs
`rclone sync site/dist httpeers:sites/<domain>`, inside that prefix only, and the host serves it
at once (old files for up to 60 s). The site's domain is **vcs.statewalker.com**;
vcs.statewalker.org redirects to it.

| Kind | Name | Value |
| --- | --- | --- |
| secret | `HTTPEERS_S3_ACCESS_KEY_ID`, `HTTPEERS_S3_SECRET_ACCESS_KEY` | credentials that can write the site's prefix in the `sites` bucket |
| variable | `SITE_DOMAIN` | optional; `vcs.statewalker.com` when unset |

Use credentials of their own, not RustFS's root pair in `/opt/httpeers/.env` on the httpeers
server, which can rewrite or delete every site in the bucket. A RustFS user whose policy allows
`s3:PutObject`, `s3:GetObject`, `s3:DeleteObject` and `s3:ListBucket` on
`sites/vcs.statewalker.com/*` only is what the workflow needs.

Without the secrets the workflow builds and checks the site and notes that it did not publish.
Run it by hand with "Run workflow" (`workflow_dispatch`).

### Going live, once

The httpeers server (163.172.46.87) runs Caddy in front of the sites host. Caddy picks the site by
the `Host` header and gets a certificate for each exact name over HTTP-01 by itself, as it does for
cellb.dev. So the steps are: DNS, then Caddy, then the content.

1. **DNS.**
   - statewalker.com is on Cloudflare: add `A vcs 163.172.46.87` with the proxy **off** ("DNS
     only", grey cloud). Behind Cloudflare's proxy, Cloudflare would answer TLS and the HTTP-01
     challenge itself instead of Caddy.
   - statewalker.org is on Gandi: add `A vcs 163.172.46.87`.
   - Wait until both resolve: `dig +short vcs.statewalker.com vcs.statewalker.org` prints the
     address twice.
2. **Caddy.** The blocks for `vcs.statewalker.com` (served) and `vcs.statewalker.org` (redirected
   to it) are in statewalker/httpeers `deploy/Caddyfile`. Deploy that file to the server as
   statewalker/httpeers `deploy/README.md` ("After any change to the Caddyfile") says: validate,
   copy in place, reload. Deploy it only after step 1: before the names resolve to the server,
   Let's Encrypt cannot validate them.
3. **Credentials.** Run `site/scripts/setup-publish-secrets.sh`. It needs ssh access to the
   server, docker and `gh` with admin rights on this repository. It reads the root pair over ssh
   (`HTTPEERS_SSH` to change the host), creates or re-keys the RustFS user `vcs-site` with
   RustFS's own client (`rc admin`, in a `rustfs/rc` container), limited to
   `sites/vcs.statewalker.com/*`, checks that the new pair can write and delete under
   `sites/<domain>/.site/`, and sets the two secrets and `SITE_DOMAIN`. Running it again rotates
   the key.
4. **Publish.** Run the workflow: `gh workflow run site.yml -R statewalker/webrun-vcs`, or push
   to `main`.
5. **Check.** `curl -sI https://vcs.statewalker.com/` answers `200`, and
   `curl -sI https://vcs.statewalker.org/x` answers `301` to `https://vcs.statewalker.com/x`.

## Style

Shared with cellb.dev's site: the shadcn token contract, Inter / JetBrains Mono, bordered cards,
grid background, mono eyebrow labels, code windows. Different: a Git orange (hue ≈ 45–55) with a
red secondary; edit `:root` / `.dark` in `src/styles/global.css` to re-skin.
