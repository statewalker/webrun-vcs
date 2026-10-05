# JGit Complete Diff Test Suite

This directory contains the complete test suite from the JGit project for diff/patch operations.

## Source

Cloned from: https://github.com/eclipse-jgit/jgit
Path: `org.eclipse.jgit.test/tst-rsrc/org/eclipse/jgit/diff/`

## Test Coverage

**Total: 161 files (58 patch files + 103 test data files)**

### Statistics

- **Total test cases**: 58
- **Binary patches**: 3 (delta, literal, literal_add)
- **Text patches**: 55
- **With PreImage**: 46
- **With PostImage**: 49
- **Both Pre & Post**: 42
- **Add operations**: 7
- **Delete operations**: 4

### Test Categories

#### Binary Patches
- **delta**: Binary delta patch (8KB files)
- **literal**: Binary literal patch (1.6KB → 5.4KB)
- **literal_add**: New binary file addition (1.6KB)

#### Text Modifications
- **M1, M2, M3**: Simple modifications
- **X, Y, Z**: Various text changes
- **W**: Text modifications
- **E**: Edit operations

#### File Operations
- **A1, A2, A3**: File additions
- **A1_sub**: Subdirectory addition
- **D**: File deletion
- **RenameNoHunks**: Rename without changes
- **RenameWithHunks**: Rename with modifications
- **CopyWithHunks**: Copy with modifications

#### Line Ending Tests
- **crlf, crlf2, crlf3, crlf4**: CRLF line ending variations
- **x_add_nl, x_add_nl_crlf**: Adding newlines
- **x_last_rm_nl, x_last_rm_nl_crlf**: Removing last newline
- **x_d, x_d_crlf**: Delete with different line endings
- **x_e, x_e_crlf**: Edit with different line endings
- **z_e_add_nl, z_e_no_nl, z_e_rm_nl**: Newline edge cases

#### Unicode/Encoding Tests
- **NonASCII, NonASCII2**: Non-ASCII characters
- **NonASCIIAdd, NonASCIIAdd2**: Adding non-ASCII files
- **NonASCIIDel**: Deleting non-ASCII content
- **umlaut**: Unicode umlaut characters

#### Conflict Tests
- **conflict**: Basic conflict markers
- **ConflictOutOfBounds**: Conflict out of range
- **allowconflict**: Allowed conflict scenarios
- **allowconflict_file_deleted**: Conflict with deleted file

#### Edge Cases
- **NL1**: Newline handling
- **emptyLine**: Empty line handling
- **hello**: Simple test case
- **very_long_file**: Large file handling
- **ShiftUp, ShiftUp2**: Context shifting up
- **ShiftDown, ShiftDown2**: Context shifting down
- **smudgetest**: Smudge filter tests
- **dotgit, dotgit2**: .git directory handling
- **XAndY**: Combined changes
- **F1, F2**: Patch fragments

## File Naming Convention

Each test case follows this pattern:
- `{name}.patch` - The patch file
- `{name}_PreImage` - State before patch (if exists)
- `{name}_PostImage` - Expected state after patch (if exists)

## File Attributes

From `.gitattributes`:
```
*.patch -crlf
*Image -crlf
*.out -crlf
delta* -text     # Binary files
literal* -text   # Binary files
```

## Test Patterns

### Basic Test Flow (from JGit's PatchApplierTest.java)

```java
@Test
public void testName() throws Exception {
    init("name");  // Loads name.patch, name_PreImage, name_PostImage
    Result result = applyPatch();
    // Validate result matches PostImage
}
```

### Binary Test Flow

```java
@Test
public void testBinaryDelta() throws Exception {
    init("delta");
    checkBinary(applyPatch(), 1);  // Byte-for-byte comparison
}
```

### Special Cases

1. **New files**: No PreImage, only PostImage
2. **Deleted files**: Only PreImage, no PostImage
3. **Renames**: PreImage and PostImage with rename markers
4. **Fragments**: Some tests have only patch files (e.g., F1, F2)

## Patch Format Types

### 1. Standard Unified Diff
```
diff --git a/file b/file
index abc123..def456 100644
--- a/file
+++ b/file
@@ -1,3 +1,4 @@
 line1
+new line
 line2
 line3
```

### 2. Binary Delta Patch
```
diff --git a/file b/file
index abc123..def456 100644
GIT binary patch
delta 14
<base85-encoded delta>

delta 12
<base85-encoded old data>
```

### 3. Binary Literal Patch
```
diff --git a/file b/file
index abc123..def456 100644
GIT binary patch
literal 5389
<base85-encoded compressed data>

literal 1629
<base85-encoded old compressed data>
```

### 4. File Mode Changes
```
diff --git a/file b/file
old mode 100644
new mode 100755
```

### 5. Renames
```
diff --git a/old b/new
rename from old
rename to new
```

### 6. Copies
```
diff --git a/source b/dest
copy from source
copy to dest
```

## Usage

### Running Full Test Suite

```bash
pnpm test jgit-full-suite.test.ts
```

### Test Output Example

```
Discovered 58 test cases
Binary tests: 3, Text tests: 55

=== JGit Test Coverage Statistics ===
Total test cases: 58
Binary patches: 3
Text patches: 55
With PreImage: 46
With PostImage: 49
With both Pre & Post: 42
Add operations: 7
Delete operations: 4
======================================

✓ 16/16 tests passed
```

## Validation Approach

The test suite validates:

1. **File Discovery**: All patch files are discovered correctly
2. **Structure**: Proper Pre/PostImage pairing
3. **Format**: Valid Git patch format (diff --git or @@ for fragments)
4. **Metadata**: Correct parsing of file modes, renames, copies
5. **Binary Detection**: Proper identification of binary patches
6. **Data Integrity**: All test data files load without errors
7. **Coverage**: Comprehensive coverage across all edge cases

## Notes

- Some tests are fragments without Pre/PostImage (e.g., A1_sub, F1, F2)
- Binary files use Git's base85 encoding
- CRLF tests verify line ending handling
- Unicode tests ensure proper encoding support
- Conflict tests verify merge conflict marker handling

## JGit Test References

- [PatchApplierTest.java](https://github.com/eclipse-jgit/jgit/blob/master/org.eclipse.jgit.test/tst/org/eclipse/jgit/patch/PatchApplierTest.java)
- [PatchTest.java](https://github.com/eclipse-jgit/jgit/blob/master/org.eclipse.jgit.test/tst/org/eclipse/jgit/patch/PatchTest.java)
- [FileHeaderTest.java](https://github.com/eclipse-jgit/jgit/blob/master/org.eclipse.jgit.test/tst/org/eclipse/jgit/patch/FileHeaderTest.java)

This comprehensive test suite ensures maximum compatibility with Git's diff/patch format and JGit's implementation.
