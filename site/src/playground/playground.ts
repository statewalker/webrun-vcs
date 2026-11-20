// The playground page's client: renders the repository's snapshot after every action.
import { PlaygroundRepository, type Snapshot } from "./repository";

const $ = <T extends HTMLElement>(selector: string) => {
  const el = document.querySelector<T>(selector);
  if (!el) throw new Error(`${selector} is missing`);
  return el;
};

const ui = {
  root: $<HTMLElement>("[data-playground]"),
  state: $<HTMLElement>("[data-pg-state]"),
  branch: $<HTMLElement>("[data-pg-branch]"),
  files: $<HTMLUListElement>("[data-pg-files]"),
  path: $<HTMLInputElement>("[data-pg-path]"),
  editor: $<HTMLTextAreaElement>("[data-pg-editor]"),
  save: $<HTMLButtonElement>("[data-pg-save]"),
  remove: $<HTMLButtonElement>("[data-pg-remove]"),
  message: $<HTMLInputElement>("[data-pg-message]"),
  commit: $<HTMLButtonElement>("[data-pg-commit]"),
  newBranch: $<HTMLInputElement>("[data-pg-new-branch]"),
  create: $<HTMLButtonElement>("[data-pg-create]"),
  branches: $<HTMLSelectElement>("[data-pg-branches]"),
  switchTo: $<HTMLButtonElement>("[data-pg-switch]"),
  merge: $<HTMLButtonElement>("[data-pg-merge]"),
  status: $<HTMLUListElement>("[data-pg-status]"),
  log: $<HTMLOListElement>("[data-pg-log]"),
  messages: $<HTMLPreElement>("[data-pg-messages]"),
  reset: $<HTMLButtonElement>("[data-pg-reset]"),
};

let repo: PlaygroundRepository;

function say(line: string) {
  ui.messages.textContent = `${line}\n${ui.messages.textContent ?? ""}`.slice(0, 4000);
}

function item(text: string, className = "") {
  const li = document.createElement("li");
  li.textContent = text;
  li.className = className;
  return li;
}

async function render(snapshot?: Snapshot) {
  const s = snapshot ?? (await repo.snapshot());
  ui.branch.textContent = s.branch;
  ui.files.replaceChildren(
    ...s.files.map((path) => {
      const li = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = path;
      button.dataset.pgFile = path;
      button.className = `w-full truncate rounded px-2 py-1 text-left font-mono text-xs hover:bg-accent ${
        path === ui.path.value ? "bg-accent text-accent-foreground" : ""
      }`;
      button.addEventListener("click", () => open(path));
      li.append(button);
      return li;
    }),
  );
  ui.branches.replaceChildren(
    ...s.branches
      .filter((b) => b !== s.branch)
      .map((b) => {
        const option = document.createElement("option");
        option.value = option.textContent = b;
        return option;
      }),
  );
  const others = s.branches.length > 1;
  ui.switchTo.disabled = ui.merge.disabled = !others;
  ui.status.replaceChildren(
    ...(s.status.length
      ? s.status.map((e) => item(`${e.state.padEnd(16)} ${e.path}`, "font-mono text-xs"))
      : [item("nothing to commit, working tree clean", "text-xs text-muted-foreground")]),
  );
  ui.log.replaceChildren(
    ...s.log.map((c) => {
      const li = document.createElement("li");
      li.className = "font-mono text-xs leading-5";
      const merge = c.parents.length > 1;
      li.innerHTML = `<span class="text-primary">${c.id.slice(0, 7)}</span> ${merge ? "<b>⑂</b> " : ""}`;
      li.append(document.createTextNode(c.message.split("\n")[0]));
      const meta = document.createElement("span");
      meta.className = "block pl-[7.5ch] text-muted-foreground";
      meta.textContent = c.parents.length
        ? `parent${merge ? "s" : ""} ${c.parents.map((p) => p.slice(0, 7)).join(", ")}`
        : "root commit";
      li.append(meta);
      return li;
    }),
  );
}

async function open(path: string) {
  ui.path.value = path;
  ui.editor.value = await repo.read(path);
  await render();
}

/** Runs an action, reports its error instead of throwing, and re-renders. */
async function act(label: string, action: () => Promise<string | undefined>) {
  ui.root.dataset.busy = "true";
  try {
    const result = await action();
    say(`✓ ${label}${result ? `: ${result}` : ""}`);
  } catch (error) {
    say(`✗ ${label}: ${(error as Error)?.message ?? error}`);
  } finally {
    await render();
    delete ui.root.dataset.busy;
  }
}

ui.save.addEventListener("click", () =>
  act(`save ${ui.path.value}`, async () => {
    const path = ui.path.value.trim();
    if (!path) throw new Error("give the file a path");
    await repo.write(path, ui.editor.value);
    return undefined;
  }),
);
ui.remove.addEventListener("click", () =>
  act(`delete ${ui.path.value}`, async () => {
    await repo.remove(ui.path.value.trim());
    ui.editor.value = "";
    return undefined;
  }),
);
ui.commit.addEventListener("click", () =>
  act("git add -A && git commit", async () => {
    const message = ui.message.value.trim() || "Update";
    const id = await repo.commitAll(message);
    ui.message.value = "";
    return `${id.slice(0, 7)} ${message}`;
  }),
);
ui.create.addEventListener("click", () =>
  act(`git checkout -b ${ui.newBranch.value}`, async () => {
    const name = ui.newBranch.value.trim();
    if (!name) throw new Error("give the branch a name");
    await repo.createBranch(name);
    ui.newBranch.value = "";
    return undefined;
  }),
);
ui.switchTo.addEventListener("click", () =>
  act(`git checkout ${ui.branches.value}`, async () => {
    await repo.switchTo(ui.branches.value);
    if (ui.path.value) ui.editor.value = await repo.read(ui.path.value).catch(() => "");
    return undefined;
  }),
);
ui.merge.addEventListener("click", () =>
  act(`git merge ${ui.branches.value}`, async () => {
    const { status, conflicts } = await repo.merge(ui.branches.value);
    if (ui.path.value) ui.editor.value = await repo.read(ui.path.value).catch(() => "");
    return conflicts.length ? `${status}; fix ${conflicts.join(", ")}, then commit` : status;
  }),
);
ui.reset.addEventListener("click", () => start());

async function start() {
  ui.messages.textContent = "";
  repo = await PlaygroundRepository.create();
  await open("README.md");
  say("✓ git init; git commit -m 'Initial commit'");
  ui.state.textContent = "ready";
  ui.state.dataset.state = "ready";
}

start().catch((error) => {
  ui.state.textContent = `failed: ${(error as Error)?.message ?? error}`;
  ui.state.dataset.state = "failed";
});
