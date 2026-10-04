/**
 * Store for rebase operation state.
 *
 * Manages Git rebase state directories:
 * - .git/rebase-merge/ (for merge-based rebase)
 * - .git/rebase-apply/ (for am-style rebase)
 */

import { joinPath, tryReadText } from "@statewalker/vcs-core";
import type { FilesApi } from "@statewalker/vcs-utils/files";
import type {
  RebaseState,
  RebaseTodoAction,
  RebaseTodoItem,
} from "@statewalker/vcs-working-tree/transformation";

/**
 * Store for rebase operation state
 */
export interface RebaseStateStore {
  /**
   * Read current rebase state
   * @returns RebaseState if rebase in progress, undefined otherwise
   */
  read(): Promise<RebaseState | undefined>;

  /**
   * Begin a rebase operation
   * @param state Initial rebase state
   */
  begin(state: Omit<RebaseState, "type" | "startedAt">): Promise<void>;

  /**
   * Advance to next step
   */
  nextStep(): Promise<void>;

  /**
   * Update the todo list (for interactive rebase)
   * @param todoList New todo list
   */
  updateTodoList(todoList: RebaseTodoItem[]): Promise<void>;

  /**
   * Complete the rebase (clean up state directories)
   */
  complete(): Promise<void>;

  /**
   * Abort the rebase (restore original state)
   */
  abort(): Promise<void>;

  /**
   * Check if rebase is in progress
   */
  isInProgress(): Promise<boolean>;

  /**
   * Get rebase type currently in progress
   */
  getRebaseType(): Promise<"rebase-merge" | "rebase-apply" | undefined>;
}

/**
 * Git file-based implementation of RebaseStateStore
 */
export class GitRebaseStateStore implements RebaseStateStore {
  private readonly gitDir: string;

  constructor(
    private readonly files: FilesApi,
    gitDir: string,
  ) {
    this.gitDir = gitDir;
  }

  async read(): Promise<RebaseState | undefined> {
    const rebaseType = await this.getRebaseType();
    if (!rebaseType) return undefined;

    const stateDir =
      rebaseType === "rebase-merge"
        ? joinPath(this.gitDir, "rebase-merge")
        : joinPath(this.gitDir, "rebase-apply");

    const headName = await tryReadText(this.files, joinPath(stateDir, "head-name"));
    const onto = await tryReadText(this.files, joinPath(stateDir, "onto"));
    const origHead = await tryReadText(this.files, joinPath(stateDir, "orig-head"));

    if (!onto || !origHead) return undefined;

    let currentStep: number;
    let totalSteps: number;

    if (rebaseType === "rebase-merge") {
      const msgnum = await tryReadText(this.files, joinPath(stateDir, "msgnum"));
      const end = await tryReadText(this.files, joinPath(stateDir, "end"));
      currentStep = parseInt(msgnum ?? "0", 10) || 0;
      totalSteps = parseInt(end ?? "0", 10) || 0;
    } else {
      const next = await tryReadText(this.files, joinPath(stateDir, "next"));
      const last = await tryReadText(this.files, joinPath(stateDir, "last"));
      currentStep = parseInt(next ?? "0", 10) || 0;
      totalSteps = parseInt(last ?? "0", 10) || 0;
    }

    const interactive = await this.files.exists(joinPath(stateDir, "interactive"));
    const todoList = interactive ? await this.parseTodoList(stateDir) : undefined;

    // Get directory modification time for startedAt
    const stats = await this.files.stats(stateDir);
    const startedAt = stats?.lastModified ? new Date(stats.lastModified) : new Date();

    return {
      type: "rebase",
      rebaseType: interactive ? "rebase-interactive" : rebaseType,
      startedAt,
      headName: headName?.trim() ?? "HEAD",
      onto: onto.trim(),
      origHead: origHead.trim(),
      currentStep,
      totalSteps,
      interactive,
      todoList,
    };
  }

  async begin(state: Omit<RebaseState, "type" | "startedAt">): Promise<void> {
    const stateDir =
      state.rebaseType === "rebase-apply"
        ? joinPath(this.gitDir, "rebase-apply")
        : joinPath(this.gitDir, "rebase-merge");

    await this.files.mkdir(stateDir);

    // Write state files
    await this.writeText(joinPath(stateDir, "head-name"), `${state.headName}\n`);
    await this.writeText(joinPath(stateDir, "onto"), `${state.onto}\n`);
    await this.writeText(joinPath(stateDir, "orig-head"), `${state.origHead}\n`);

    if (state.rebaseType === "rebase-apply") {
      await this.writeText(joinPath(stateDir, "next"), `${state.currentStep.toString()}\n`);
      await this.writeText(joinPath(stateDir, "last"), `${state.totalSteps.toString()}\n`);
      await this.writeText(joinPath(stateDir, "rebasing"), "");
    } else {
      await this.writeText(joinPath(stateDir, "msgnum"), `${state.currentStep.toString()}\n`);
      await this.writeText(joinPath(stateDir, "end"), `${state.totalSteps.toString()}\n`);
    }

    if (state.interactive) {
      await this.writeText(joinPath(stateDir, "interactive"), "");
    }

    if (state.todoList) {
      await this.writeTodoList(stateDir, state.todoList);
    }
  }

  async nextStep(): Promise<void> {
    const rebaseType = await this.getRebaseType();
    if (!rebaseType) return;

    const stateDir =
      rebaseType === "rebase-merge"
        ? joinPath(this.gitDir, "rebase-merge")
        : joinPath(this.gitDir, "rebase-apply");

    const stepFile = rebaseType === "rebase-merge" ? "msgnum" : "next";
    const currentText = await tryReadText(this.files, joinPath(stateDir, stepFile));
    const currentStep = parseInt(currentText ?? "0", 10) || 0;
    await this.writeText(joinPath(stateDir, stepFile), `${(currentStep + 1).toString()}\n`);
  }

  async updateTodoList(todoList: RebaseTodoItem[]): Promise<void> {
    const rebaseType = await this.getRebaseType();
    if (!rebaseType) return;

    const stateDir =
      rebaseType === "rebase-merge"
        ? joinPath(this.gitDir, "rebase-merge")
        : joinPath(this.gitDir, "rebase-apply");

    await this.writeTodoList(stateDir, todoList);
  }

  async complete(): Promise<void> {
    await this.removeStateDirs();
  }

  async abort(): Promise<void> {
    await this.removeStateDirs();
  }

  async isInProgress(): Promise<boolean> {
    return (await this.getRebaseType()) !== undefined;
  }

  async getRebaseType(): Promise<"rebase-merge" | "rebase-apply" | undefined> {
    const rebaseMergePath = joinPath(this.gitDir, "rebase-merge");
    const rebaseApplyPath = joinPath(this.gitDir, "rebase-apply");

    const rebaseMergeStats = await this.files.stats(rebaseMergePath);
    if (rebaseMergeStats?.kind === "directory") {
      return "rebase-merge";
    }

    const rebaseApplyStats = await this.files.stats(rebaseApplyPath);
    if (rebaseApplyStats?.kind === "directory") {
      return "rebase-apply";
    }

    return undefined;
  }

  // === Private Helpers ===

  private async removeStateDirs(): Promise<void> {
    await this.removeDirectory(joinPath(this.gitDir, "rebase-merge"));
    await this.removeDirectory(joinPath(this.gitDir, "rebase-apply"));
  }

  private async removeDirectory(path: string): Promise<void> {
    const stats = await this.files.stats(path);
    if (!stats || stats.kind !== "directory") return;

    // Remove all files in directory
    for await (const entry of this.files.list(path)) {
      await this.files.remove(joinPath(path, entry.name));
    }
    // Remove directory itself
    await this.files.remove(path);
  }

  private async parseTodoList(stateDir: string): Promise<RebaseTodoItem[]> {
    const todoPath = joinPath(stateDir, "git-rebase-todo");
    const content = await tryReadText(this.files, todoPath);
    if (!content) return [];

    const lines = content.split("\n").filter((line) => line.trim() && !line.startsWith("#"));

    return lines.map((line) => {
      const parts = line.split(/\s+/);
      const action = parts[0] as RebaseTodoAction;
      const commit = parts[1] ?? "";
      const message = parts.slice(2).join(" ");
      return { action, commit, message };
    });
  }

  private async writeTodoList(stateDir: string, todoList: RebaseTodoItem[]): Promise<void> {
    const lines = todoList.map((item) => `${item.action} ${item.commit} ${item.message}`);
    await this.writeText(joinPath(stateDir, "git-rebase-todo"), `${lines.join("\n")}\n`);
  }

  private async writeText(path: string, content: string): Promise<void> {
    const data = new TextEncoder().encode(content);
    await this.files.write(path, [data]);
  }
}

/**
 * Factory function for creating RebaseStateStore
 *
 * @param files FilesApi implementation
 * @param gitDir Path to .git directory
 */
export function createRebaseStateStore(files: FilesApi, gitDir: string): RebaseStateStore {
  return new GitRebaseStateStore(files, gitDir);
}
