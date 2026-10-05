# Test Logging

Tests in this package use a centralized logging utility to avoid verbose console output during normal test runs.

## Usage

### Default Behavior
By default, all `testLog()` calls are suppressed:

```bash
pnpm test
```

No console.log output will be shown.

### Enabling Debug Logging
To see debug output from tests, set one of these environment variables:

```bash
# Option 1: Using DEBUG_TESTS
DEBUG_TESTS=1 pnpm test

# Option 2: Using VERBOSE_TESTS
VERBOSE_TESTS=1 pnpm test

# Option 3: Running specific tests with logging
DEBUG_TESTS=1 pnpm test jgit-full-suite
```

## In Test Code

Import and use the test logger:

```typescript
import { testLog } from '../test-logger.js';

describe('My Test Suite', () => {
  it('should do something', () => {
    const result = doSomething();

    // This will only print if DEBUG_TESTS=1 or VERBOSE_TESTS=1
    testLog('Result:', result);

    expect(result).toBe(expected);
  });
});
```

## API

### `testLog(...args)`
Logs messages to console only when `DEBUG_TESTS` or `VERBOSE_TESTS` environment variable is set to `'1'` or `'true'`.

```typescript
testLog('Simple message');
testLog('Multiple', 'arguments', 123);
testLog({ complex: 'object' });
```

### `isTestLogEnabled()`
Returns `true` if test logging is currently enabled.

```typescript
if (isTestLogEnabled()) {
  // Perform expensive logging operations
  testLog(generateDetailedReport());
}
```

## Migration from console.log

Replace all `console.log()` calls in tests with `testLog()`:

```typescript
// Before
console.log('Test result:', result);

// After
import { testLog } from '../test-logger.js';
testLog('Test result:', result);
```
