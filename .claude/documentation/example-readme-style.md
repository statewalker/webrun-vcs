# Example Application README Style Guide

**Reference files:** `apps/example-git-cycle/README.md`, `apps/example-vcs-http-roundtrip/README.md`

This guide describes the structure and style for README files in example applications.

## Core Structure

Every example README should follow this structure:

### 1. Title and Introduction

Start with the example name as H1, followed by a narrative paragraph explaining what the example demonstrates and why it matters.

```markdown
# example-name

[One to two sentences describing what this example does and demonstrates.]
This example shows how to [concrete accomplishment] using [key technologies/concepts].
```

**Example:**
> # 02-porcelain-commands
>
> Complete Git workflow using the Commands API (porcelain layer). This example
> demonstrates high-level Git operations that mirror familiar git commands like
> `commit`, `branch`, `checkout`, `merge`, `log`, `diff`, `status`, `tag`, and `stash`.

### 2. Quick Start Section

Provide the fastest path to running the example.

```markdown
## Quick Start

\`\`\`bash
# From the monorepo root
pnpm install
pnpm --filter @statewalker/vcs-example-name start
\`\`\`
```

### 3. Running Individual Steps (if applicable)

For multi-step examples, show how to run each step independently.

```markdown
## Running Individual Steps

Each step can be run independently:

\`\`\`bash
pnpm --filter @statewalker/vcs-example-name step:01  # Step description
pnpm --filter @statewalker/vcs-example-name step:02  # Step description
\`\`\`
```

### 4. What You'll Learn / Goals

List the learning outcomes or goals as bullet points.

```markdown
## What You'll Learn

- [Concrete skill or concept]
- [Another skill or concept]
- [Yet another skill or concept]
```

### 5. Prerequisites

```markdown
## Prerequisites

- Node.js 24
- pnpm (via corepack)
- [Any prior examples that should be completed first]
```

### 6. Step-by-Step Guide (Main Content)

This is the heart of the README. Each step should follow this pattern:

```markdown
---

## Step-by-Step Guide

### Step N: Step Title

**File:** [src/steps/NN-step-name.ts](src/steps/NN-step-name.ts)

[Brief explanation of what this step demonstrates - 1-2 sentences]

\`\`\`typescript
// Key code snippet showing the essential pattern
// Keep it focused and minimal - ideally 5-15 lines
\`\`\`

**Key APIs:**
- `ClassName.methodName()` - Brief description
- `anotherMethod()` - Brief description

[Optional: Additional explanation, tables, or concepts specific to this step]

---
```

**Important patterns:**

1. **File links**: Always link to the source file
2. **Code snippets**: Show real, working code - not pseudocode
3. **Key APIs section**: List the main APIs used with brief descriptions
4. **Horizontal dividers**: Use `---` between steps for visual separation
5. **Tables**: Use tables for comparing options or listing constants

### 7. Key Concepts

After the steps, provide conceptual explanations that tie everything together.

```markdown
## Key Concepts

### Concept Name

[Narrative explanation - not just bullet points. Explain the "why" not just the "what".]

### Another Concept

[More narrative explanation with optional code examples or tables.]
```

### 8. Project Structure

Show the directory layout of the example.

```markdown
## Project Structure

\`\`\`
apps/examples/example-name/
├── package.json
├── tsconfig.json
├── README.md
└── src/
    ├── main.ts           # Main entry point
    ├── shared.ts         # Shared utilities
    └── steps/
        ├── 01-step.ts    # Step description
        └── 02-step.ts    # Step description
\`\`\`
```

### 9. API Reference Links

Link to source code for the main APIs used.

```markdown
## API Reference Links

### Package Name (packages/pkg)

| Interface/Class | Location | Purpose |
|-----------------|----------|---------|
| `ClassName` | [path/to/file.ts](../../../path/to/file.ts) | Brief purpose |
```

### 10. Output Example

Show what the user will see when running the example.

```markdown
## Output Example

\`\`\`
[Actual or representative console output]
[Show key steps and their results]
[Include section headers matching the code output]
\`\`\`
```

### 11. Next Steps

Link to related examples.

```markdown
## Next Steps

- [Next Example](../next-example/) - Brief description
- [Related Example](../related-example/) - Brief description
```

## Style Guidelines

### Code Snippets

**Good:**
```typescript
// Store content as a blob
const blobId = await repository.blobs.store([content]);

// Create a tree
const treeId = await repository.trees.storeTree([
  { mode: FileMode.REGULAR_FILE, name: "README.md", id: blobId },
]);
```

**Avoid:**
```typescript
// This is where we store the content as a blob
// The blob is stored using the blobs.store method
// which takes an array of Uint8Array chunks
const blobId = await repository.blobs.store([content]); // store returns ObjectId
```

### Tables

Use tables for:
- File modes and constants
- API method comparisons
- Strategy/option lists
- Type definitions

```markdown
| Mode | Constant | Description |
|------|----------|-------------|
| `040000` | `FileMode.TREE` | Directory |
| `100644` | `FileMode.REGULAR_FILE` | Regular file |
```

### Key APIs Sections

Keep them brief - just method name and one-line description:

```markdown
**Key APIs:**
- `git.commit()` - Create a commit from staged changes
- `git.branchCreate()` - Create a new branch
```

### Links

Use relative links to source files from the README location:

- Within the example: `[file.ts](src/file.ts)`
- To packages: `[file.ts](../../../packages/core/src/file.ts)`

### Narrative vs Lists

Prefer narrative paragraphs in explanations. Use lists only for:
- Prerequisites
- Learning outcomes
- Key APIs
- Quick references

## Checklist

Before committing an example README, verify:

- [ ] Clear introduction explaining the example's purpose
- [ ] Quick Start section with exact commands
- [ ] Each step has: file link, code snippet, key APIs
- [ ] Code snippets are minimal and focused (5-15 lines)
- [ ] Tables used appropriately for constants/options
- [ ] Project structure diagram included
- [ ] Output example shows realistic console output
- [ ] All links are relative and correct
- [ ] Next Steps links to related examples
- [ ] Horizontal dividers between major sections
- [ ] No excessive bullet points in narrative sections
