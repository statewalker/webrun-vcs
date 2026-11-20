// Runs every live example of the built site in Chromium, as a visitor would: opens
// /examples/<name>/, presses Run and waits for the outcome; then drives the playground through
// a branch, a commit on each side and a merge. Fails on any error or failed run.
//
//   pnpm build && pnpm check:examples          (serves dist/ on a port of its own)
//   pnpm check:examples quick-start fetch-push (some examples only)
//
// PW_CHROMIUM=/path/to/chrome uses that browser instead of Playwright's own.

import { readFile, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { chromium } from "playwright";

const NAMES = ["quick-start", "branching-merging", "object-model", "git-directory", "fetch-push"];
const only = process.argv.slice(2);
const list = NAMES.filter((name) => !only.length || only.includes(name));
const withPlayground = !only.length || only.includes("playground");

// dist/ as a static host serves it.
const DIST = new URL("../dist/", import.meta.url).pathname;
const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".wasm": "application/wasm",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".woff2": "font/woff2",
};
const server = createServer(async (req, res) => {
  let file = join(DIST, normalize(decodeURIComponent(new URL(req.url, "http://x").pathname)));
  try {
    if ((await stat(file)).isDirectory()) file = join(file, "index.html");
    const body = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream" });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ executablePath: process.env.PW_CHROMIUM || undefined });
const failures = [];

/** A page that records uncaught errors and console errors. */
async function openPage(path) {
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto(`${base}${path}`);
  return { context, page, errors };
}

async function checkExample(name) {
  const { context, page, errors } = await openPage(`/examples/${name}/`);
  let outcome;
  try {
    await page.click("[data-run-button]");
    await page.waitForFunction(
      () => /done|failed/.test(document.querySelector("[data-run-status]")?.dataset.state ?? ""),
      null,
      { timeout: 60_000 },
    );
    const state = await page.getAttribute("[data-run-status]", "data-state");
    const status = await page.textContent("[data-run-status]");
    const output = (await page.textContent("[data-run-output]")) ?? "";
    if (state !== "done") throw new Error(`${status}\n${output}`);
    if (!output.trim()) throw new Error("the run printed nothing");
    if (name === "git-directory") {
      const link = page.locator("[data-download='repository.zip']");
      if (!(await link.count())) throw new Error("no repository.zip download");
      const [download] = await Promise.all([page.waitForEvent("download"), link.click()]);
      const path = await download.path();
      const bytes = await readFile(path);
      if (bytes.subarray(0, 2).toString() !== "PK") throw new Error("repository.zip is not a zip");
    }
    if (errors.length) throw new Error(`page errors: ${errors.join("; ")}`);
    outcome = `ok   ${name}: ${status}`;
  } catch (err) {
    outcome = `FAIL ${name}: ${err.message.split("\n").slice(0, 6).join("\n     ")}`;
    failures.push(name);
  }
  console.log(outcome);
  await context.close();
}

async function checkPlayground() {
  const { context, page, errors } = await openPage("/examples/playground/");
  const step = async (button, wait = 300) => {
    await page.click(button);
    await page.waitForFunction(() => !document.querySelector("[data-playground]")?.dataset.busy);
    await page.waitForTimeout(wait);
  };
  try {
    await page.waitForFunction(
      () => /ready|failed/.test(document.querySelector("[data-pg-state]")?.dataset.state ?? ""),
      null,
      { timeout: 30_000 },
    );
    if ((await page.getAttribute("[data-pg-state]", "data-state")) !== "ready") {
      throw new Error(await page.textContent("[data-pg-state]"));
    }
    // A branch with a new file.
    await page.fill("[data-pg-new-branch]", "feature");
    await step("[data-pg-create]");
    await page.fill("[data-pg-path]", "feature.txt");
    await page.fill("[data-pg-editor]", "made on a branch\n");
    await step("[data-pg-save]");
    await page.fill("[data-pg-message]", "Add feature.txt");
    await step("[data-pg-commit]");
    // Back to main: a change there, then the merge.
    await page.selectOption("[data-pg-branches]", "main");
    await step("[data-pg-switch]");
    if (await page.locator("[data-pg-file='feature.txt']").count()) {
      throw new Error("feature.txt is still in main's worktree after the switch");
    }
    await page.fill("[data-pg-path]", "README.md");
    await page.fill("[data-pg-editor]", "# Playground\n\nChanged on main.\n");
    await step("[data-pg-save]");
    await page.fill("[data-pg-message]", "Change README on main");
    await step("[data-pg-commit]");
    await page.selectOption("[data-pg-branches]", "feature");
    await step("[data-pg-merge]");
    const messages = (await page.textContent("[data-pg-messages]")) ?? "";
    const log = (await page.textContent("[data-pg-log]")) ?? "";
    if (messages.includes("✗")) throw new Error(`an action failed:\n${messages}`);
    if (!log.includes("Merge branch 'feature'"))
      throw new Error(`no merge commit in the log:\n${log}`);
    if (!(await page.locator("[data-pg-file='feature.txt']").count())) {
      throw new Error("feature.txt is missing after the merge");
    }
    if (errors.length) throw new Error(`page errors: ${errors.join("; ")}`);
    console.log("ok   playground: branch, commit on both sides, switch, merge");
  } catch (err) {
    console.log(`FAIL playground: ${err.message}`);
    failures.push("playground");
  }
  await context.close();
}

try {
  for (const name of list) await checkExample(name);
  if (withPlayground) await checkPlayground();
} finally {
  await browser.close();
  server.close();
}
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed: ${failures.join(", ")}`);
  process.exit(1);
}
console.log(`\nall ${list.length + (withPlayground ? 1 : 0)} checks passed`);
