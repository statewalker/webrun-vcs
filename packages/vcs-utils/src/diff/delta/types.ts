/**
 * A function that returns an async iterable starting at a given byte offset.
 * Used for streaming delta application where COPY instructions
 * reference arbitrary positions in the base object.
 */
export type RandomAccessStream = (start?: number) => AsyncIterable<Uint8Array>;

export type DeltaRange =
  | { from: "source"; start: number; len: number }
  | { from: "target"; start: number; len: number };

export type Delta =
  | {
      type: "start";
      /** Length of the source/base object (required for Git delta serialization) */
      sourceLen?: number;
      targetLen: number;
    }
  | {
      type: "copy";
      start: number;
      len: number;
    }
  | {
      type: "insert";
      data: Uint8Array;
    }
  | {
      type: "finish";
      checksum: number;
    };
