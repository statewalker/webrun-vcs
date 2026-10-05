/**
 * Test Helpers for Transport Package
 *
 * Provides test infrastructure for Git transport protocol testing.
 * Modeled after JGit's test utilities.
 */

// Test HTTP Server Helper
export {
  type AuthConfig,
  type CapturedExchange,
  type CapturedRequest,
  type CapturedResponse,
  createInitializedHttpServer,
  createTestHttpServer,
  type DelayConfig,
  type RedirectConfig,
  TestHttpServer,
  type TestHttpServerConfig,
} from "./test-http-server.js";

// Test Protocol Helper
export {
  createMockRefStore,
  createMockRepository,
  createMockTransport,
  createTestContext,
  type MockRefStore,
  type MockTransport,
  PacketSequenceBuilder,
  type PktLineResult,
  ProtocolMessages,
  type ProtocolScenario,
  packets,
  randomOid,
  runProtocolScenario,
  type SidebandResult,
  testOid,
  verifyPackets,
} from "./test-protocol.js";
// Test Repository Helper
export {
  createComplexRepository,
  createInitializedRepository,
  createTestRepository,
  type ObjectType,
  type StoredObject,
  type TestCommit,
  TestRepository,
  type TestTag,
  type TreeEntry,
} from "./test-repository.js";
