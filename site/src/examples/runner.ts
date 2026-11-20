// The live example pages' client: imports the page's example module, runs it with an Output
// that writes into the page, and reports the outcome in [data-run-status] (read by
// scripts/check-examples.mjs).
import type { Output } from "./output";

type Example = { default: (out: Output) => Promise<void> };

const modules: Record<string, () => Promise<Example>> = {
  "quick-start": () => import("./quick-start"),
  "branching-merging": () => import("./branching-merging"),
  "object-model": () => import("./object-model"),
  "git-directory": () => import("./git-directory"),
  "fetch-push": () => import("./fetch-push"),
};

export function mountRunner(root: HTMLElement) {
  const name = root.dataset.example ?? "";
  const button = root.querySelector<HTMLButtonElement>("[data-run-button]");
  const output = root.querySelector<HTMLElement>("[data-run-output]");
  const status = root.querySelector<HTMLElement>("[data-run-status]");
  const downloads = root.querySelector<HTMLElement>("[data-run-downloads]");
  if (!button || !output || !status || !downloads) return;

  button.addEventListener("click", async () => {
    button.disabled = true;
    output.textContent = "";
    downloads.replaceChildren();
    status.textContent = "running…";
    status.dataset.state = "running";
    const started = performance.now();
    const out: Output = {
      log(line = "") {
        output.textContent += `${line}\n`;
      },
      download(fileName, bytes, type = "application/octet-stream") {
        const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
        const link = document.createElement("a");
        link.href = url;
        link.download = fileName;
        link.dataset.download = fileName;
        link.className =
          "inline-flex h-8 items-center gap-2 rounded-md border bg-background px-3 text-xs font-medium hover:bg-accent";
        link.textContent = `Download ${fileName} (${(bytes.length / 1024).toFixed(1)} KB)`;
        downloads.append(link);
      },
    };
    try {
      const load = modules[name];
      if (!load) throw new Error(`no example named ${name}`);
      await (await load()).default(out);
      status.textContent = `done in ${Math.round(performance.now() - started)} ms`;
      status.dataset.state = "done";
    } catch (error) {
      out.log(String((error as Error)?.stack ?? error));
      status.textContent = `failed: ${(error as Error)?.message ?? error}`;
      status.dataset.state = "failed";
    } finally {
      button.disabled = false;
      button.textContent = "Run again";
    }
  });
}

for (const root of document.querySelectorAll<HTMLElement>("[data-example]")) mountRunner(root);
