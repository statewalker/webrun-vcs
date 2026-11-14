/**
 * Native `AtomicFiles` on Node's fs: `createExclusive` is open(…, "wx")
 * (O_CREAT|O_EXCL), the call git and JGit rely on for lock files; `replace` is
 * rename(2), atomic on POSIX file systems; `append` is O_APPEND. Exclusivity
 * therefore holds across processes, native git included.
 */
import {
  appendFile,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rmdir,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import type { AtomicFiles } from "@statewalker/vcs-utils/files";

const code = (e: unknown) => (e as NodeJS.ErrnoException)?.code;

/**
 * `AtomicFiles` rooted at a directory on disk (for refs: the `.git` directory).
 *
 * @example
 * ```typescript
 * const files = createNodeAtomicFiles("/path/to/repo/.git");
 * const refs = new FileRefStore(createNodeFilesApi({ rootDir: "/path/to/repo" }), ".git", {
 *   atomicFiles: files,
 * });
 * ```
 */
export function createNodeAtomicFiles(root: string): AtomicFiles {
  const abs = (path: string) => join(root, path);
  const isFile = async (path: string) => {
    try {
      return (await stat(abs(path))).isFile();
    } catch {
      return false;
    }
  };
  return {
    async *read(path) {
      try {
        yield new Uint8Array(await readFile(abs(path)));
      } catch (e) {
        if (code(e) !== "ENOENT" && code(e) !== "EISDIR") throw e;
      }
    },
    exists: isFile,
    async remove(path) {
      // unlink, not stat + rm: only the caller that actually removed the file gets true.
      try {
        await unlink(abs(path));
        return true;
      } catch (e) {
        if (code(e) === "ENOENT" || code(e) === "ENOTDIR" || code(e) === "EISDIR") return false;
        // unlink of a directory is EPERM on some systems; any other EPERM is a real failure.
        if (code(e) === "EPERM" && (await lstat(abs(path)).catch(() => undefined))?.isDirectory()) {
          return false;
        }
        throw e;
      }
    },
    async write(path, content) {
      await mkdir(dirname(abs(path)), { recursive: true });
      await writeFile(abs(path), content);
    },
    async *list(dir) {
      let entries: string[];
      try {
        entries = (await readdir(abs(dir), { recursive: true })) as string[];
      } catch {
        return;
      }
      const out: string[] = [];
      for (const entry of entries) {
        const full = join(abs(dir), entry);
        try {
          if ((await stat(full)).isFile()) out.push(relative(root, full).split(sep).join("/"));
        } catch {
          // removed meanwhile
        }
      }
      yield* out.sort();
    },
    async createExclusive(path, content) {
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      // As git's raceproof_create_file: another writer may prune an empty parent
      // directory between our mkdir and open; create it again and retry.
      for (let attempt = 0; !handle; attempt++) {
        await mkdir(dirname(abs(path)), { recursive: true });
        try {
          handle = await open(abs(path), "wx");
        } catch (e) {
          if (code(e) === "EEXIST") return false;
          if (code(e) !== "ENOENT" || attempt >= 10) throw e;
        }
      }
      try {
        await handle.writeFile(content);
        await handle.close();
      } catch (e) {
        // Roll back a half-written lock, as git does; it would block writers forever.
        await handle.close().catch(() => {});
        await unlink(abs(path)).catch(() => {});
        throw e;
      }
      return true;
    },
    async replace(source, target) {
      await mkdir(dirname(abs(target)), { recursive: true });
      await rename(abs(source), abs(target));
    },
    async append(path, content) {
      await mkdir(dirname(abs(path)), { recursive: true });
      await appendFile(abs(path), content);
    },
    async removeEmptyDir(dir) {
      try {
        await rmdir(abs(dir)); // fails unless an empty directory
        return true;
      } catch {
        return false;
      }
    },
  };
}
