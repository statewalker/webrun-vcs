/**
 * File reading utilities
 *
 * These functions replace the removed readFile() method on FilesApi.
 * They use read() + collect() internally, providing a clean separation
 * between the streaming interface and convenience functions.
 */

import { collect } from "../streams/index.js";
import { readBlock } from "../streams/read-header.js";
import type { FilesApi } from "./files-api.js";

/**
 * Read entire file content as Uint8Array.
 * Uses files.read() internally with collect().
 */
export async function readFile(files: FilesApi, path: string): Promise<Uint8Array> {
  return collect(files.read(path));
}

/**
 * Read entire file content as UTF-8 text.
 * Uses files.read() internally with collect() + TextDecoder.
 */
export async function readText(files: FilesApi, path: string): Promise<string> {
  const bytes = await collect(files.read(path));
  return new TextDecoder().decode(bytes);
}

/**
 * Read file or return undefined if not found.
 * Useful for optional config files.
 */
export async function tryReadFile(files: FilesApi, path: string): Promise<Uint8Array | undefined> {
  try {
    return await collect(files.read(path));
  } catch (error) {
    if (isNotFoundError(error)) {
      return undefined;
    }
    throw error;
  }
}

/**
 * Read text file or return undefined if not found.
 */
export async function tryReadText(files: FilesApi, path: string): Promise<string | undefined> {
  const bytes = await tryReadFile(files, path);
  return bytes ? new TextDecoder().decode(bytes) : undefined;
}

/**
 * Check if error is a "not found" error.
 */
export function isNotFoundError(error: unknown): boolean {
  if (error && typeof error === "object" && "code" in error) {
    return (error as { code: string }).code === "ENOENT";
  }
  return false;
}

/**
 * Read bytes at specific position into buffer.
 * Replaces FileHandle.read() pattern.
 *
 * Uses readBlock() from streams internally.
 *
 * @param files - FilesApi instance
 * @param path - File path
 * @param buffer - The buffer to read bytes into
 * @param bufferOffset - The offset in the buffer to start writing at
 * @param length - The number of bytes to read
 * @param position - The position in the file to start reading from
 * @returns The number of bytes actually read
 */
export async function readAt(
  files: FilesApi,
  path: string,
  buffer: Uint8Array,
  bufferOffset: number,
  length: number,
  position: number,
): Promise<number> {
  const data = await readBlock(files.read(path, { start: position, length }), length);
  buffer.set(data, bufferOffset);
  return data.length;
}

/**
 * Read bytes at specific position, returning new Uint8Array.
 * Simpler alternative when you don't need to write into existing buffer.
 *
 * Uses readBlock() from streams internally.
 *
 * @param files - FilesApi instance
 * @param path - File path
 * @param position - The position in the file to start reading from
 * @param length - The number of bytes to read
 * @returns A Uint8Array containing the requested bytes
 */
export async function readRange(
  files: FilesApi,
  path: string,
  position: number,
  length: number,
): Promise<Uint8Array> {
  return readBlock(files.read(path, { start: position, length }), length);
}
