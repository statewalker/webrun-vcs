import type { FileStats, FilesApi, ListOptions } from "../../common/files/index.js";
import type { RawStorage } from "../../storage/raw/raw-storage.js";

/**
 * Create a mock RawStorage that records all operations.
 */
export function createMockRawStorage(): {
  storage: RawStorage;
  operations: Array<{ method: string; args: unknown[] }>;
} {
  const data = new Map<string, Uint8Array>();
  const operations: Array<{ method: string; args: unknown[] }> = [];

  const storage: RawStorage = {
    async store(key, content) {
      operations.push({ method: "store", args: [key] });
      const chunks: Uint8Array[] = [];
      for await (const chunk of content) {
        chunks.push(chunk);
      }
      const total = chunks.reduce((s, c) => s + c.length, 0);
      const result = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.length;
      }
      data.set(key, result);
    },

    async *load(key, options) {
      operations.push({ method: "load", args: [key, options] });
      const content = data.get(key);
      if (content) {
        const start = options?.start ?? 0;
        const end = options?.end ?? content.length;
        yield content.slice(start, end);
      }
    },

    async has(key) {
      operations.push({ method: "has", args: [key] });
      return data.has(key);
    },

    async remove(key) {
      operations.push({ method: "remove", args: [key] });
      return data.delete(key);
    },

    async *keys() {
      operations.push({ method: "keys", args: [] });
      for (const key of data.keys()) {
        yield key;
      }
    },

    async size(key) {
      operations.push({ method: "size", args: [key] });
      return data.get(key)?.length ?? 0;
    },
  };

  return { storage, operations };
}

/**
 * Create a mock FilesApi for testing without filesystem.
 */
export function createMockFilesApi(): FilesApi & {
  _files: Map<string, Uint8Array>;
  _dirs: Set<string>;
} {
  const files = new Map<string, Uint8Array>();
  const dirs = new Set<string>();

  return {
    _files: files,
    _dirs: dirs,

    async *read(path: string): AsyncIterable<Uint8Array> {
      const content = files.get(path);
      if (!content) throw new Error(`File not found: ${path}`);
      yield content;
    },

    async write(
      path: string,
      content: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
    ): Promise<void> {
      const chunks: Uint8Array[] = [];
      for await (const chunk of content) {
        chunks.push(chunk);
      }
      const total = chunks.reduce((s, c) => s + c.length, 0);
      const result = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.length;
      }
      files.set(path, result);
    },

    async exists(path: string): Promise<boolean> {
      return files.has(path) || dirs.has(path);
    },

    async mkdir(path: string): Promise<void> {
      dirs.add(path);
    },

    // Honours `options.recursive`, deliberately. This double is typed as
    // `FilesApi`, and TS method parameters are bivariant, so a narrower
    // `list(path)` would keep compiling while silently dropping the option —
    // any test passing `{ recursive: true }` would get shallow results and pass
    // for the wrong reason. Omitting the argument yields exactly the previous
    // behaviour, so no existing caller changes.
    async *list(
      path: string,
      options?: ListOptions,
    ): AsyncIterable<{ name: string; path: string; kind: "file" | "directory" }> {
      const prefix = path.endsWith("/") ? path : `${path}/`;
      const seen = new Set<string>();

      for (const filePath of files.keys()) {
        if (filePath.startsWith(prefix)) {
          const relative = filePath.slice(prefix.length);
          const parts = relative.split("/");
          if (options?.recursive) {
            yield { name: parts[parts.length - 1], path: filePath, kind: "file" };
          } else if (parts.length === 1 && !seen.has(parts[0])) {
            seen.add(parts[0]);
            yield { name: parts[0], path: filePath, kind: "file" };
          }
        }
      }

      for (const dir of dirs) {
        if (dir.startsWith(prefix)) {
          const relative = dir.slice(prefix.length);
          const parts = relative.split("/");
          if (options?.recursive) {
            yield { name: parts[parts.length - 1], path: dir, kind: "directory" };
          } else if (parts.length === 1 && !seen.has(parts[0])) {
            seen.add(parts[0]);
            yield { name: parts[0], path: dir, kind: "directory" };
          }
        }
      }
    },

    async remove(path: string): Promise<boolean> {
      const hadFile = files.delete(path);
      const hadDir = dirs.delete(path);
      return hadFile || hadDir;
    },

    async move(source: string, target: string): Promise<boolean> {
      const content = files.get(source);
      if (content) {
        files.set(target, content);
        files.delete(source);
        return true;
      }
      return false;
    },

    async stats(path: string): Promise<FileStats | undefined> {
      if (files.has(path)) {
        return {
          kind: "file",
          size: files.get(path)?.length ?? 0,
          lastModified: Date.now(),
        };
      }
      if (dirs.has(path)) {
        return {
          kind: "directory",
          size: 0,
          lastModified: Date.now(),
        };
      }
      return undefined;
    },

    async copy(source: string, target: string): Promise<boolean> {
      const content = files.get(source);
      if (!content) return false;
      files.set(target, new Uint8Array(content));
      return true;
    },
  };
}

/**
 * Create a mock Transport for testing protocol handling.
 */
export function createMockTransport(_options?: {
  refs?: Record<string, string>;
  packResponse?: Uint8Array;
}): {
  requests: Array<{ type: string; data: unknown }>;
} {
  const requests: Array<{ type: string; data: unknown }> = [];

  // Mock transport - implementation depends on transport interface
  // For now, just return the requests array for tracking

  return { requests };
}
