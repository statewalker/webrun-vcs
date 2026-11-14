/**
 * Internal Storage Example
 *
 * Demonstrates low-level object and pack operations for application integration.
 *
 * Steps:
 * 1. Loose Objects - Understanding how Git stores individual objects
 * 2. Pack Files - Bundling objects into efficient pack format
 * 3. Garbage Collection - Cleaning up redundant objects
 * 4. Direct Storage - Bypassing Git index for content-addressable storage
 * 5. Delta Internals - Understanding delta compression
 *
 * Run all steps: pnpm start
 * Run specific step: pnpm start --step=01
 */

import { state } from "./shared/index.js";

// Import step modules
import * as step01 from "./steps/01-loose-objects.js";
import * as step02 from "./steps/02-pack-files.js";
import * as step03 from "./steps/03-garbage-collection.js";
import * as step04 from "./steps/04-direct-storage.js";
import * as step05 from "./steps/05-delta-internals.js";

interface Step {
  name: string;
  run: () => Promise<void>;
}

const steps: Step[] = [
  { name: "01-loose-objects", run: step01.run },
  { name: "02-pack-files", run: step02.run },
  { name: "03-garbage-collection", run: step03.run },
  { name: "04-direct-storage", run: step04.run },
  { name: "05-delta-internals", run: step05.run },
];

function parseArgs(): { stepFilter: string | null } {
  const args = process.argv.slice(2);
  let stepFilter: string | null = null;

  for (const arg of args) {
    if (arg.startsWith("--step=")) {
      stepFilter = arg.slice(7);
    }
  }

  return { stepFilter };
}

async function main(): Promise<void> {
  console.log("\n============================================================");
  console.log("          Internal Storage Example");
  console.log("          Low-Level Object & Pack Operations");
  console.log("============================================================\n");

  const { stepFilter } = parseArgs();

  if (stepFilter) {
    // Run specific step
    const step = steps.find((s) => s.name.startsWith(stepFilter));
    if (!step) {
      console.error(`Unknown step: ${stepFilter}`);
      console.log("Available steps:");
      for (const s of steps) {
        console.log(`  --step=${s.name.substring(0, 2)}`);
      }
      process.exit(1);
    }

    console.log(`Running step: ${step.name}\n`);

    // For steps that need prior state, run prerequisites
    const stepIndex = steps.indexOf(step);
    if (stepIndex > 0) {
      console.log("Running prerequisites...\n");
      for (let i = 0; i < stepIndex; i++) {
        await steps[i].run();
      }
    }

    await step.run();
  } else {
    // Run all steps
    console.log("Running all steps...\n");

    for (const step of steps) {
      try {
        await step.run();
      } catch (error) {
        console.error(`\nStep ${step.name} failed:`, error);
        process.exit(1);
      }
    }

    // Final summary
    console.log("\n============================================================");
    console.log("                     Summary");
    console.log("============================================================\n");

    console.log("This example demonstrated:");
    console.log("  1. How Git stores objects as loose files");
    console.log("  2. How pack files bundle objects efficiently");
    console.log("  3. How garbage collection removes redundant data");
    console.log("  4. How to use storage directly for applications");
    console.log("  5. How delta compression reduces storage");

    console.log("\nKey APIs used:");
    console.log("  - repository.blobs.store() - Store blob objects");
    console.log("  - repository.blobs.load() - Load blob content");
    console.log("  - repository.objects.get(id) - Get object type, size and content");
    console.log("  - PackWriterStream - Create pack files");
    console.log("  - createDeltaRanges() - Compute deltas");
    console.log("  - applyDelta() - Reconstruct from delta");

    console.log("\nUse cases:");
    console.log("  - Content-addressable storage without Git workflow");
    console.log("  - Version tracking without working tree");
    console.log("  - Custom delta compression for applications");
    console.log("  - Understanding Git internals for debugging");
  }

  // Cleanup: close history
  if (state.history) {
    await state.history.close();
  }

  console.log("\nExample completed successfully!\n");
}

// Run main
main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
