// Checks every internal link of the built site: each href and src in dist/**/*.html that points
// into the site must name a file of dist/, and a #fragment must name an id (or name) on the
// target page. External links (another origin) are not fetched.
//
//   pnpm build && pnpm check:links

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, relative } from "node:path";

const DIST = new URL("../dist/", import.meta.url).pathname;
if (!existsSync(join(DIST, "index.html"))) {
  console.error("dist/index.html is missing: run the build first.");
  process.exit(1);
}

const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );
const pages = walk(DIST).filter((f) => f.endsWith(".html"));

/** The file of dist/ a site path resolves to, as the sites host serves it, or undefined. */
function fileOf(path) {
  const candidates = path.endsWith("/")
    ? [`${path}index.html`]
    : [path, `${path}/index.html`, `${path}.html`];
  for (const c of candidates) {
    const file = join(DIST, c);
    if (existsSync(file) && statSync(file).isFile()) return file;
  }
  return undefined;
}

const idCache = new Map();
/** Every id and name attribute of a page. */
function idsOf(file) {
  let ids = idCache.get(file);
  if (!ids) {
    const html = readFileSync(file, "utf8");
    ids = new Set([...html.matchAll(/\s(?:id|name)="([^"]+)"/g)].map((m) => m[1]));
    idCache.set(file, ids);
  }
  return ids;
}

const decode = (s) => s.replaceAll("&amp;", "&").replaceAll("&quot;", '"').replaceAll("&#39;", "'");

const failures = [];
let checked = 0;
for (const page of pages) {
  const html = readFileSync(page, "utf8");
  // The page's own path in the site: dist/docs/index.html → /docs/
  const rel = `/${relative(DIST, page).split("\\").join("/")}`;
  const pagePath = rel.endsWith("/index.html") ? rel.slice(0, -"index.html".length) : rel;
  for (const m of html.matchAll(/\s(href|src)="([^"]*)"/g)) {
    const raw = decode(m[2]);
    if (!raw || /^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith("//")) continue; // external
    checked++;
    const [beforeHash, fragment] = raw.split("#", 2);
    const pathPart = beforeHash.split("?")[0];
    let target;
    if (!pathPart) {
      target = page; // "#x" or "?q": this page
    } else {
      const absolute = pathPart.startsWith("/")
        ? pathPart
        : posix.join(posix.dirname(`${pagePath}x`), pathPart);
      target = fileOf(decodeURIComponent(absolute));
      if (!target) {
        failures.push(`${rel}: ${raw} (no such file in dist/)`);
        continue;
      }
    }
    if (fragment && target.endsWith(".html") && !idsOf(target).has(decodeURIComponent(fragment))) {
      failures.push(`${rel}: ${raw} (no id "${fragment}" on the target page)`);
    }
  }
}

if (failures.length) {
  console.error(`${failures.length} broken internal link(s):`);
  for (const f of failures) console.error(`  ${f}`);
  process.exit(1);
}
console.log(`check-links: ${checked} internal links on ${pages.length} pages, all resolve`);
