// After `astro build`: the published site's hosting options, and a compressed copy of each text
// asset. The httpeers sites host compresses nothing itself (Caddy in front of it does not
// either); with `precompressed` it serves `<file>.br` or `<file>.gz` beside a file to browsers
// that accept them (statewalker/httpeers apps/sites/README.md).
//
//   dist/.site/config.json   the site's options on the host: copies served, and /_astro/
//                            (file names with content hashes) cached for good
//   dist/**/<file>.br, .gz   for text files (JS, CSS, HTML, JSON, SVG, WASM…) of 1 KB or more,
//                            when the copy is at least 10% smaller
//
// A copy is written only when it is missing or older than its file, so a second run is quick.
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";

const dist = new URL("../dist/", import.meta.url).pathname;
const COMPRESSIBLE = /\.(html|js|mjs|css|json|svg|xml|txt|wasm|map|md|csv|ts|jsonc)$/;
const MIN_SIZE = 1024;

const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  );

mkdirSync(join(dist, ".site"), { recursive: true });
writeFileSync(
  join(dist, ".site/config.json"),
  `${JSON.stringify(
    {
      notFound: "/404.html",
      cacheControl: "public, no-cache",
      cacheRules: [{ prefix: "/_astro/", cacheControl: "public, max-age=31536000, immutable" }],
      precompressed: true,
    },
    null,
    2,
  )}\n`,
);

let files = 0;
let before = 0;
let after = 0;
for (const file of walk(dist)) {
  if (!COMPRESSIBLE.test(file) || file.includes("/.site/")) continue;
  const stats = statSync(file);
  // A copy the file no longer gets must go: the host serves any copy it finds.
  const drop = (target) => rmSync(target, { force: true });
  if (stats.size < MIN_SIZE) {
    drop(`${file}.br`);
    drop(`${file}.gz`);
    continue;
  }
  let bytes;
  const copies = [
    // Brotli's best quality costs long on multi-megabyte files: those get 9, a few percent larger.
    [
      ".br",
      (b) =>
        brotliCompressSync(b, {
          params: { [constants.BROTLI_PARAM_QUALITY]: b.length > 1048576 ? 9 : 11 },
        }),
    ],
    [".gz", (b) => gzipSync(b, { level: 9 })],
  ];
  let smallest = stats.size;
  for (const [suffix, compress] of copies) {
    const target = file + suffix;
    let size;
    try {
      const existing = statSync(target);
      if (existing.mtimeMs >= stats.mtimeMs) size = existing.size;
    } catch {}
    if (size == null) {
      bytes ??= readFileSync(file);
      const out = compress(bytes);
      if (out.length > stats.size * 0.9) {
        drop(target); // not worth a copy
        continue;
      }
      writeFileSync(target, out);
      size = out.length;
    }
    smallest = Math.min(smallest, size);
  }
  files++;
  before += stats.size;
  after += smallest;
}
const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;
console.log(
  `compress: ${files} files, ${mb(before)} → ${mb(after)} for a browser that takes br; .site/config.json written`,
);
