/**
 * Options for splitStream.
 */
export interface SplitStreamOptions {
  /**
   * If true, all generators will finish when the input ends.
   * Otherwise, the last generator may remain open.
   */
  finishOnEnd?: boolean;
}

/**
 * Splits an async iterable stream into multiple async generators.
 * The `split` function determines the split point within each block.
 * When a split point is found - the returned split position value is
 * more or equal to zero - the current generator interrupts and a new
 * one starts.
 * @param input The input async iterable stream
 * @param split Function that determines the split point within each block.
 * @param options Configuration options (or boolean for backwards compat with finishOnEnd)
 */
export async function* splitStream(
  input: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  split: (block: Uint8Array) => number,
  options: SplitStreamOptions | boolean = false,
): AsyncGenerator<AsyncGenerator<Uint8Array>> {
  // Handle backwards compatibility: options can be boolean (finishOnEnd)
  const opts: SplitStreamOptions =
    typeof options === "boolean" ? { finishOnEnd: options } : options;
  const finishOnEnd = opts.finishOnEnd ?? false;

  const iterator = (async function* () {
    yield* input;
  })();

  // Track pending block and whether it came from iterator (vs re-split remainder)
  let lastBlock: Uint8Array | null = null;
  let lastBlockFromIterator = false;
  let finished = false;

  // Peek at iterator to ensure we have content before yielding a generator
  async function ensureContent(): Promise<boolean> {
    if (lastBlock !== null) return true;
    if (finished) return false;
    const slot = await iterator.next();
    if (slot.done) {
      finished = true;
      return false;
    }
    lastBlock = slot.value;
    lastBlockFromIterator = true;
    return true;
  }

  try {
    // Always yield at least one generator (may be empty for empty stream)
    let first = true;
    while (first || (await ensureContent())) {
      first = false;
      yield readNextGenerator();
    }
  } finally {
    if (finishOnEnd) {
      finished = true;
    }
  }

  async function* readNextGenerator(): AsyncGenerator<Uint8Array> {
    while (!finished) {
      let block: Uint8Array;
      let blockFromIterator: boolean;

      if (lastBlock !== null) {
        block = lastBlock;
        blockFromIterator = lastBlockFromIterator;
        lastBlock = null;
        lastBlockFromIterator = false;
      } else {
        const slot = await iterator.next();
        if (slot.done) {
          finished = true;
          break;
        }
        block = slot.value;
        blockFromIterator = true;
      }

      const splitPoint = split(block);
      if (splitPoint >= 0) {
        // Split point found - set remainder
        const remainder = block.subarray(splitPoint);
        if (remainder.length > 0) {
          // Non-empty remainder: always keep for next segment
          lastBlock = remainder;
          lastBlockFromIterator = false; // It's a re-split remainder
        } else if (blockFromIterator) {
          // Empty remainder from iterator block: create empty segment
          lastBlock = remainder;
          lastBlockFromIterator = true;
        } else {
          // Empty remainder from re-split: discard
          lastBlock = null;
          lastBlockFromIterator = false;
        }
        // Only yield if there's something before the split point
        if (splitPoint > 0) {
          yield block.subarray(0, splitPoint);
        }
        // Stop current generator and start a new one
        break;
      }
      // No split point, yield entire block
      yield block;
    }
  }
}

/**
 * Creates a simple byte splitter that looks for a single byte delimiter.
 * @param char
 * @returns
 */
export function newByteSplitter(char: number): (block: Uint8Array) => number {
  return (block: Uint8Array): number => {
    for (let i = 0; i < block.length; i++) {
      if (block[i] === char) {
        return i + 1; // Include the delimiter in the split
      }
    }
    return -1; // No split point found
  };
}

/**
 * Creates a stateful splitter that can find a delimiter spanning multiple blocks.
 * The returned function maintains internal state across calls to detect delimiters
 * that are split across block boundaries.
 *
 * @param delimiter The byte sequence to search for
 * @returns A function that takes a block and returns the end position of the delimiter
 *          in that block if found, or -1 if not found yet
 */
export function newSplitter(delimiter: Uint8Array): (block: Uint8Array) => number {
  // Buffer to hold the tail of previous blocks (up to delimiter.length - 1 bytes)
  // This allows detecting delimiters that span block boundaries
  let buffer = new Uint8Array(0);

  return (block: Uint8Array): number => {
    const combinedLength = buffer.length + block.length;
    for (let i = 0; i <= combinedLength - delimiter.length; i++) {
      let match = true;
      for (let j = 0; j < delimiter.length; j++) {
        const byte = delimiter[j];
        if (i + j < buffer.length) {
          if (buffer[i + j] !== byte) {
            match = false;
            break;
          }
        } else {
          const blockIndex = i + j - buffer.length;
          if (block[blockIndex] !== byte) {
            match = false;
            break;
          }
        }
      }
      if (match) {
        // Found! Calculate position in original block where delimiter ends
        const endInCombined = i + delimiter.length;
        const endInBlock = endInCombined - buffer.length;
        buffer = new Uint8Array(0);
        return endInBlock;
      }
    }

    // No match found, save last (delimiter.length - 1) bytes as potential partial match
    const keepLen = Math.min(delimiter.length - 1, combinedLength);
    if (keepLen <= 0) {
      buffer = new Uint8Array(0);
    } else if (keepLen <= block.length) {
      // All bytes we need are in the current block
      buffer = block.slice(block.length - keepLen);
    } else {
      // Need bytes from both buffer and block
      const bytesFromBuffer = keepLen - block.length;
      const newBuffer = new Uint8Array(keepLen);
      newBuffer.set(buffer.slice(buffer.length - bytesFromBuffer), 0);
      newBuffer.set(block, bytesFromBuffer);
      buffer = newBuffer;
    }

    return -1;
  };
}
