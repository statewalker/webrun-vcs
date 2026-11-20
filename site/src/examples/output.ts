/** Where a live example writes: the page's output panel (or the console, in a test run). */
export interface Output {
  /** Prints one line. */
  log(line?: string): void;
  /** Offers the visitor a file to save (a button under the output). */
  download(name: string, bytes: Uint8Array, type?: string): void;
}
