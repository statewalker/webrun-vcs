/**
 * Tests for MemoryRefs implementation
 *
 * Runs conformance tests against the native in-memory Refs implementation.
 */

import { MemoryRefs } from "../../../src/history/refs/refs.impl.js";
import type { Refs } from "../../../src/history/refs/refs.js";
import { refsConformanceTests } from "./refs.conformance.test.js";

let refs: MemoryRefs;

refsConformanceTests(
  "MemoryRefs",
  async (): Promise<Refs> => {
    refs = new MemoryRefs();
    return refs;
  },
  async (): Promise<void> => {
    refs.clear();
  },
);
