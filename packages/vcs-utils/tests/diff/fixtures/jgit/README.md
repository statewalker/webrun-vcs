# JGit Binary Patch Test Data

This directory contains test data from the [JGit project](https://github.com/eclipse-jgit/jgit) used to validate binary diff compatibility with Git's binary patch format.

## Source

Test data downloaded from:
`https://github.com/eclipse-jgit/jgit/tree/master/org.eclipse.jgit.test/tst-rsrc/org/eclipse/jgit/diff`

## Files

### Delta Format Tests
- **delta_PreImage** - Original binary file (8,192 bytes)
- **delta_PostImage** - Modified binary file (8,197 bytes)
- **delta.patch** - Git binary delta patch

The delta test uses descending byte values (0xFF, 0xFE, 0xFD...) and tests delta compression where changes are encoded as copy/insert operations.

### Literal Format Tests
- **literal_PreImage** - Original binary file (1,629 bytes)
- **literal_PostImage** - Modified binary file (5,389 bytes)
- **literal.patch** - Git binary literal patch

The literal test encodes the entire file content using base85 encoding with zlib compression.

### Literal Add Tests
- **literal_add_PostImage** - New binary file (1,629 bytes)
- **literal_add.patch** - Git binary patch for new file

Tests adding a new binary file (no PreImage).

## Git Binary Patch Format

Git uses two formats for binary patches:

### 1. Delta Format
```
GIT binary patch
delta 14
<base85-encoded delta instructions>

delta 12
<base85-encoded old size>
```

Delta patches encode changes as:
- **Copy operations**: Copy N bytes from source at offset X
- **Insert operations**: Insert N literal bytes

### 2. Literal Format
```
GIT binary patch
literal 5389
<base85-encoded compressed data>

literal 1629
<base85-encoded old compressed data>
```

Literal patches contain the complete file content, zlib-compressed and base85-encoded.

## Base85 Encoding

Git uses a modified base85 encoding where:
- Each line starts with a length character: `A` = 1 byte, `B` = 2 bytes, etc.
- Character set: `0-9A-Za-z!#$%&()*+-;<=>?@^_`{|}~`
- 5 encoded characters represent 4 bytes of data
- Lines starting with `z` represent groups of bytes

## Test Coverage

The test suite validates:
1. **File loading** - All test fixtures load correctly
2. **Patch parsing** - Correctly parse delta and literal patch formats
3. **Base85 decoding** - Decode Git's base85 encoding with length prefixes
4. **Delta application** - Apply delta instructions to binary data
5. **Data integrity** - Verify binary file characteristics
6. **Format compliance** - Patches follow Git binary patch specification

## Usage

Run the tests:
```bash
pnpm test jgit-binary-patches.test.ts
```

## JGit Testing Approach

JGit uses this pattern for binary patch tests:
1. Load PreImage and PostImage files
2. Parse the patch file
3. Apply patch to PreImage
4. Validate result matches PostImage byte-for-byte

This ensures compatibility with Git's binary diff implementation.
