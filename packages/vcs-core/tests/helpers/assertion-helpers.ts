/**
 * Assertion helpers for testing Git operations
 */

import type { Delta } from "@statewalker/vcs-utils";
import { applyDelta } from "@statewalker/vcs-utils";
import { expect } from "vitest";
import type { ObjectId } from "../../src/common/id/index.js";
import type { Refs } from "../../src/history/refs/refs.js";
import type { RawStorage } from "../../src/storage/raw/raw-storage.js";

/**
 * Collect all chunks from an async iterable into a single Uint8Array
 */
export async function collectBytes(iterable: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  for await (const chunk of iterable) {
    chunks.push(chunk);
  }
  const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

/**
 * Assert that applying delta to base produces expected result
 */
export function assertDeltaApplies(base: Uint8Array, delta: Delta[], expected: Uint8Array): void {
  const chunks: Uint8Array[] = [];
  for (const chunk of applyDelta(base, delta)) {
    chunks.push(chunk);
  }
  const result = concatBytes(chunks);
  expect(result).toEqual(expected);
}

/**
 * Assert that storing and loading produces the same content
 */
export async function assertRoundTrip(
  store: RawStorage,
  key: string,
  content: Uint8Array,
): Promise<void> {
  await store.store(key, [content]);
  const loaded = await collectBytes(store.load(key));
  expect(loaded).toEqual(content);
}

/**
 * Assert reference resolves to expected ObjectId
 */
export async function assertRefResolution(
  store: Refs,
  name: string,
  expected: ObjectId,
): Promise<void> {
  const ref = await store.resolve(name);
  expect(ref).toBeDefined();
  expect(ref?.objectId).toBe(expected);
}

/**
 * Assert that two byte arrays are equal
 */
export function assertBytesEqual(actual: Uint8Array, expected: Uint8Array, message?: string): void {
  expect(actual.length).toBe(expected.length);
  for (let i = 0; i < actual.length; i++) {
    if (actual[i] !== expected[i]) {
      throw new Error(
        `${message ?? "Bytes differ"} at position ${i}: expected ${expected[i]}, got ${actual[i]}`,
      );
    }
  }
}

/**
 * Assert that store contains expected keys
 */
export async function assertStoreContains(store: RawStorage, keys: string[]): Promise<void> {
  for (const key of keys) {
    const hasKey = await store.has(key);
    expect(hasKey).toBe(true);
  }
}

/**
 * Assert that store does not contain keys
 */
export async function assertStoreNotContains(store: RawStorage, keys: string[]): Promise<void> {
  for (const key of keys) {
    const hasKey = await store.has(key);
    expect(hasKey).toBe(false);
  }
}

/**
 * Concatenate multiple Uint8Arrays into one
 */
export function concatBytes(arrays: Uint8Array[]): Uint8Array {
  const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const arr of arrays) {
    result.set(arr, offset);
    offset += arr.length;
  }
  return result;
}

/**
 * Wait for async iterable to complete and collect all items
 */
export async function collectAll<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) {
    items.push(item);
  }
  return items;
}

/**
 * Create a matcher for partial object comparison
 */
export function matchPartial<T>(partial: Partial<T>) {
  return expect.objectContaining(partial);
}

/**
 * Assert that an async function throws an error with specific message
 */
export async function assertThrowsAsync(
  fn: () => Promise<unknown>,
  messagePattern?: string | RegExp,
): Promise<void> {
  let threw = false;
  try {
    await fn();
  } catch (e) {
    threw = true;
    if (messagePattern) {
      const message = e instanceof Error ? e.message : String(e);
      if (typeof messagePattern === "string") {
        expect(message).toContain(messagePattern);
      } else {
        expect(message).toMatch(messagePattern);
      }
    }
  }
  expect(threw).toBe(true);
}

/**
 * Create a spy that tracks calls to an async function
 */
export function createAsyncSpy<T extends (...args: unknown[]) => Promise<unknown>>(
  impl?: T,
): T & { calls: Parameters<T>[] } {
  const calls: Parameters<T>[] = [];
  const spy = (async (...args: Parameters<T>) => {
    calls.push(args);
    if (impl) {
      return impl(...args);
    }
    return undefined;
  }) as T & { calls: Parameters<T>[] };
  spy.calls = calls;
  return spy;
}
