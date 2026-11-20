// Checks the built site (dist/) for internal links that lead nowhere: every href and src that
// points into the site must resolve to a file, and every #fragment must name an id in its target
// page. External links (http:, mailto:, //host) are not fetched. Exits 1 and lists each broken
// link with the page it is on.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dist = resolve(dirname(fileURLToPath(import.meta.url)), "../dist");
if (!existsSync(dist)) {
  console.error(`check-links: ${dist} does not exist; run the site build first`);
  process.exit(1);
}

const pages = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    else if (name.endsWith(".html")) pages.push(path);
  }
};
walk(dist);

/** The file a site path is served from: the file itself, or dir/index.html, or path.html. */
const target = (pathname) => {
  const path = join(dist, decodeURIComponent(pathname));
  for (const candidate of [path, join(path, "index.html"), `${path}.html`]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return undefined;
};

const idsCache = new Map();
const idsOf = (file) => {
  let ids = idsCache.get(file);
  if (!ids) {
    ids = new Set();
    for (const m of readFileSync(file, "utf8").matchAll(/\s(?:id|name)=(?:"([^"]*)"|'([^']*)')/g)) {
      ids.add(m[1] ?? m[2]);
    }
    idsCache.set(file, ids);
  }
  return ids;
};

const broken = [];
let checked = 0;
for (const page of pages) {
  const html = readFileSync(page, "utf8");
  const pagePath = `/${relative(dist, page).replaceAll("\\", "/")}`;
  for (const m of html.matchAll(/\s(href|src)=(?:"([^"]*)"|'([^']*)')/g)) {
    const raw = (m[2] ?? m[3]).replaceAll("&amp;", "&");
    if (!raw || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(raw)) continue; // external, data:, mailto:…
    const url = new URL(raw, `https://site.invalid${pagePath}`);
    checked++;
    const file = url.pathname === pagePath || raw.startsWith("#") ? page : target(url.pathname);
    if (!file) {
      broken.push(`${pagePath}: ${m[1]}="${raw}" (no such file)`);
      continue;
    }
    const fragment = decodeURIComponent(url.hash.slice(1));
    if (fragment && extname(file) === ".html" && !idsOf(file).has(fragment)) {
      broken.push(`${pagePath}: ${m[1]}="${raw}" (no id "${fragment}" in ${relative(dist, file)})`);
    }
  }
}

if (broken.length > 0) {
  console.error(`check-links: ${broken.length} broken internal link(s):`);
  for (const line of broken) console.error(`  ${line}`);
  process.exit(1);
}
console.log(`check-links: ${checked} internal links in ${pages.length} pages, all resolve`);
