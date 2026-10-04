/**
 * Store for sequencer state (multi-commit cherry-pick/revert).
 *
 * Manages Git sequencer directory:
 * - .git/sequencer/
 *   - head: original HEAD
 *   - todo: remaining commits to process
 *   - done: completed commits
 *   - opts: operation options
 */

import { joinPath, tryReadText } from "@statewalker/vcs-core";
import type { FilesApi } from "@statewalker/vcs-utils/files";
import type {
  SequencerOptions,
  SequencerState,
  SequencerTodoItem,
} from "@statewalker/vcs-working-tree/transformation";

/**
 * Store for sequencer state (multi-commit cherry-pick/revert)
 */
export interface SequencerStore {
  /**
   * Read current sequencer state
   */
  read(): Promise<SequencerState | undefined>;

  /**
   * Begin a sequencer operation
   */
  begin(state: Omit<SequencerState, "done" | "current">): Promise<void>;

  /**
   * Mark current item as done and advance to next
   */
  advance(): Promise<void>;

  /**
   * Skip current item and advance to next
   */
  skip(): Promise<void>;

  /**
   * Complete the sequencer (clean up state)
   */
  complete(): Promise<void>;

  /**
   * Abort the sequencer (clean up state)
   */
  abort(): Promise<void>;

  /**
   * Check if sequencer is in progress
   */
  isInProgress(): Promise<boolean>;
}

/**
 * Git file-based implementation of SequencerStore
 */
export class GitSequencerStore implements SequencerStore {
  private readonly sequencerDir: string;

  constructor(
    private readonly files: FilesApi,
    gitDir: string,
  ) {
    this.sequencerDir = joinPath(gitDir, "sequencer");
  }

  async read(): Promise<SequencerState | undefined> {
    if (!(await this.isInProgress())) {
      return undefined;
    }

    const head = await tryReadText(this.files, joinPath(this.sequencerDir, "head"));
    const todo = await this.parseTodoFile(joinPath(this.sequencerDir, "todo"));
    const done = await this.parseTodoFile(joinPath(this.sequencerDir, "done"));
    const options = await this.parseOptionsFile();

    // Determine operation type from opts or first todo item
    const operation =
      options.operation ?? (todo[0]?.action === "revert" ? "revert" : "cherry-pick");

    return {
      operation,
      head: head?.trim() ?? "",
      todo,
      done,
      current: todo[0],
      options,
    };
  }

  async begin(state: Omit<SequencerState, "done" | "current">): Promise<void> {
    await this.files.mkdir(this.sequencerDir);

    // Write head
    await this.writeText(joinPath(this.sequencerDir, "head"), `${state.head}\n`);

    // Write todo
    await this.writeTodoFile(joinPath(this.sequencerDir, "todo"), state.todo);

    // Write empty done file
    await this.writeTodoFile(joinPath(this.sequencerDir, "done"), []);

    // Write options
    await this.writeOptionsFile(state.options, state.operation);
  }

  async advance(): Promise<void> {
    const todo = await this.parseTodoFile(joinPath(this.sequencerDir, "todo"));
    const done = await this.parseTodoFile(joinPath(this.sequencerDir, "done"));

    if (todo.length === 0) return;

    // Move first todo item to done
    const completed = todo.shift();
    if (completed) {
      done.push(completed);
    }

    await this.writeTodoFile(joinPath(this.sequencerDir, "todo"), todo);
    await this.writeTodoFile(joinPath(this.sequencerDir, "done"), done);
  }

  async skip(): Promise<void> {
    const todo = await this.parseTodoFile(joinPath(this.sequencerDir, "todo"));

    if (todo.length === 0) return;

    // Remove first todo item without adding to done
    todo.shift();

    await this.writeTodoFile(joinPath(this.sequencerDir, "todo"), todo);
  }

  async complete(): Promise<void> {
    await this.removeDirectory(this.sequencerDir);
  }

  async abort(): Promise<void> {
    await this.removeDirectory(this.sequencerDir);
  }

  async isInProgress(): Promise<boolean> {
    const stats = await this.files.stats(this.sequencerDir);
    return stats?.kind === "directory";
  }

  // === Private Helpers ===

  private async parseTodoFile(path: string): Promise<SequencerTodoItem[]> {
    const content = await tryReadText(this.files, path);
    if (!content) return [];

    const lines = content.split("\n").filter((line) => line.trim());

    return lines.map((line) => {
      const parts = line.split(/\s+/);
      const action = parts[0] as "pick" | "revert";
      const commit = parts[1] ?? "";
      const message = parts.slice(2).join(" ");
      return { action, commit, message };
    });
  }

  private async writeTodoFile(path: string, items: SequencerTodoItem[]): Promise<void> {
    const lines = items.map((item) => `${item.action} ${item.commit} ${item.message}`);
    await this.writeText(path, lines.length > 0 ? `${lines.join("\n")}\n` : "");
  }

  private async parseOptionsFile(): Promise<
    SequencerOptions & { operation?: "cherry-pick" | "revert" }
  > {
    const optsPath = joinPath(this.sequencerDir, "opts");
    const content = await tryReadText(this.files, optsPath);
    if (!content) return {};

    const options: SequencerOptions & { operation?: "cherry-pick" | "revert" } = {};

    for (const line of content.split("\n")) {
      const eqIndex = line.indexOf("=");
      if (eqIndex === -1) continue;

      const key = line.slice(0, eqIndex).trim();
      const value = line.slice(eqIndex + 1).trim();

      switch (key) {
        case "no-commit":
          options.noCommit = value !== "false";
          break;
        case "mainline":
          options.mainlineParent = parseInt(value, 10);
          break;
        case "strategy":
          options.strategy = value;
          break;
        case "operation":
          options.operation = value as "cherry-pick" | "revert";
          break;
        case "skip-empty":
          options.skipEmpty = value !== "false";
          break;
      }
    }

    return options;
  }

  private async writeOptionsFile(
    options: SequencerOptions,
    operation: "cherry-pick" | "revert",
  ): Promise<void> {
    const lines: string[] = [];
    lines.push(`operation=${operation}`);

    if (options.noCommit) lines.push("no-commit=true");
    if (options.mainlineParent !== undefined) {
      lines.push(`mainline=${options.mainlineParent}`);
    }
    if (options.strategy) lines.push(`strategy=${options.strategy}`);
    if (options.skipEmpty) lines.push("skip-empty=true");

    await this.writeText(joinPath(this.sequencerDir, "opts"), `${lines.join("\n")}\n`);
  }

  private async removeDirectory(path: string): Promise<void> {
    const stats = await this.files.stats(path);
    if (!stats || stats.kind !== "directory") return;

    for await (const entry of this.files.list(path)) {
      await this.files.remove(joinPath(path, entry.name));
    }
    await this.files.remove(path);
  }

  private async writeText(path: string, content: string): Promise<void> {
    const data = new TextEncoder().encode(content);
    await this.files.write(path, [data]);
  }
}

/**
 * Factory function for creating SequencerStore
 *
 * @param files FilesApi implementation
 * @param gitDir Path to .git directory
 */
export function createSequencerStore(files: FilesApi, gitDir: string): SequencerStore {
  return new GitSequencerStore(files, gitDir);
}
