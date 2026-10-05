import type { RawText } from "./raw-text.js";
import type { SequenceComparator } from "./sequence.js";

/**
 * Check if a byte is whitespace.
 *
 * Whitespace characters are: space (0x20), tab (0x09), CR (0x0d), LF (0x0a)
 */
function isWhitespace(c: number): boolean {
  return c === 0x20 || c === 0x09 || c === 0x0d || c === 0x0a;
}

/**
 * Trim trailing whitespace from a byte range.
 *
 * @param raw The byte array
 * @param start Start index (inclusive)
 * @param end End index (exclusive)
 * @returns New end index after trimming
 */
function trimTrailingWhitespace(raw: Uint8Array, start: number, end: number): number {
  let ptr = end - 1;
  while (start <= ptr && isWhitespace(raw[ptr])) {
    ptr--;
  }
  return ptr + 1;
}

/**
 * Trim leading whitespace from a byte range.
 *
 * @param raw The byte array
 * @param start Start index (inclusive)
 * @param end End index (exclusive)
 * @returns New start index after trimming
 */
function trimLeadingWhitespace(raw: Uint8Array, start: number, end: number): number {
  while (start < end && isWhitespace(raw[start])) {
    start++;
  }
  return start;
}

/**
 * Comparator for RawText sequences.
 *
 * Compares lines of text using byte-by-byte comparison, with optional
 * whitespace handling modes based on JGit's RawTextComparator.
 */
export class RawTextComparator implements SequenceComparator<RawText> {
  /** Default singleton instance - exact byte comparison */
  static readonly DEFAULT = new RawTextComparator("default");

  /** Ignores all whitespace when comparing */
  static readonly WS_IGNORE_ALL = new RawTextComparator("ws_ignore_all");

  /** Ignores leading whitespace when comparing */
  static readonly WS_IGNORE_LEADING = new RawTextComparator("ws_ignore_leading");

  /** Ignores trailing whitespace when comparing */
  static readonly WS_IGNORE_TRAILING = new RawTextComparator("ws_ignore_trailing");

  /** Ignores whitespace amount changes (any whitespace equals any whitespace) */
  static readonly WS_IGNORE_CHANGE = new RawTextComparator("ws_ignore_change");

  private readonly mode:
    | "default"
    | "ws_ignore_all"
    | "ws_ignore_leading"
    | "ws_ignore_trailing"
    | "ws_ignore_change";

  private constructor(
    mode:
      | "default"
      | "ws_ignore_all"
      | "ws_ignore_leading"
      | "ws_ignore_trailing"
      | "ws_ignore_change",
  ) {
    this.mode = mode;
  }

  /**
   * Compare two items to determine if they are equal.
   *
   * @param a First sequence
   * @param ai Index of line in first sequence
   * @param b Second sequence
   * @param bi Index of line in second sequence
   * @returns true if the lines are equal
   */
  equals(a: RawText, ai: number, b: RawText, bi: number): boolean {
    const aRaw = a.getRawString(ai);
    const bRaw = b.getRawString(bi);

    switch (this.mode) {
      case "default":
        return this.equalsDefault(aRaw, bRaw);
      case "ws_ignore_all":
        return this.equalsIgnoreAll(aRaw, bRaw);
      case "ws_ignore_leading":
        return this.equalsIgnoreLeading(aRaw, bRaw);
      case "ws_ignore_trailing":
        return this.equalsIgnoreTrailing(aRaw, bRaw);
      case "ws_ignore_change":
        return this.equalsIgnoreChange(aRaw, bRaw);
    }
  }

  private equalsDefault(aRaw: Uint8Array, bRaw: Uint8Array): boolean {
    if (aRaw.length !== bRaw.length) {
      return false;
    }

    for (let i = 0; i < aRaw.length; i++) {
      if (aRaw[i] !== bRaw[i]) {
        return false;
      }
    }

    return true;
  }

  /**
   * Compare ignoring all whitespace.
   *
   * Skips all whitespace characters when comparing.
   */
  private equalsIgnoreAll(aRaw: Uint8Array, bRaw: Uint8Array): boolean {
    let as = 0;
    let bs = 0;
    const ae = trimTrailingWhitespace(aRaw, 0, aRaw.length);
    const be = trimTrailingWhitespace(bRaw, 0, bRaw.length);

    while (as < ae && bs < be) {
      let ac = aRaw[as];
      let bc = bRaw[bs];

      // Skip whitespace in both sequences
      while (as < ae - 1 && isWhitespace(ac)) {
        as++;
        ac = aRaw[as];
      }

      while (bs < be - 1 && isWhitespace(bc)) {
        bs++;
        bc = bRaw[bs];
      }

      if (ac !== bc) {
        return false;
      }

      as++;
      bs++;
    }

    return as === ae && bs === be;
  }

  /**
   * Compare ignoring leading whitespace only.
   *
   * Trims leading whitespace before comparing.
   */
  private equalsIgnoreLeading(aRaw: Uint8Array, bRaw: Uint8Array): boolean {
    const as = trimLeadingWhitespace(aRaw, 0, aRaw.length);
    const bs = trimLeadingWhitespace(bRaw, 0, bRaw.length);
    const ae = aRaw.length;
    const be = bRaw.length;

    if (ae - as !== be - bs) {
      return false;
    }

    for (let ai = as, bi = bs; ai < ae; ai++, bi++) {
      if (aRaw[ai] !== bRaw[bi]) {
        return false;
      }
    }

    return true;
  }

  /**
   * Compare ignoring trailing whitespace only.
   *
   * Trims trailing whitespace before comparing.
   */
  private equalsIgnoreTrailing(aRaw: Uint8Array, bRaw: Uint8Array): boolean {
    const as = 0;
    const bs = 0;
    const ae = trimTrailingWhitespace(aRaw, 0, aRaw.length);
    const be = trimTrailingWhitespace(bRaw, 0, bRaw.length);

    if (ae - as !== be - bs) {
      return false;
    }

    for (let ai = as, bi = bs; ai < ae; ai++, bi++) {
      if (aRaw[ai] !== bRaw[bi]) {
        return false;
      }
    }

    return true;
  }

  /**
   * Compare treating any whitespace as equal to any other whitespace.
   *
   * Multiple spaces, tabs, etc. are treated as equivalent to a single space.
   */
  private equalsIgnoreChange(aRaw: Uint8Array, bRaw: Uint8Array): boolean {
    let as = 0;
    let bs = 0;
    const ae = trimTrailingWhitespace(aRaw, 0, aRaw.length);
    const be = trimTrailingWhitespace(bRaw, 0, bRaw.length);

    while (as < ae && bs < be) {
      const ac = aRaw[as++];
      const bc = bRaw[bs++];

      if (isWhitespace(ac) && isWhitespace(bc)) {
        // Both are whitespace - skip remaining whitespace in both
        as = trimLeadingWhitespace(aRaw, as, ae);
        bs = trimLeadingWhitespace(bRaw, bs, be);
      } else if (ac !== bc) {
        return false;
      }
    }

    return as === ae && bs === be;
  }

  /**
   * Get the hash code for a line in a sequence.
   *
   * Uses a simple hash algorithm similar to Java's String.hashCode().
   *
   * @param seq Sequence
   * @param index Index of line
   * @returns Hash code for the line
   */
  hash(seq: RawText, index: number): number {
    const raw = seq.getRawString(index);
    return this.hashRegion(raw, 0, raw.length);
  }

  private hashRegion(raw: Uint8Array, ptr: number, end: number): number {
    switch (this.mode) {
      case "default":
        return this.hashDefault(raw, ptr, end);
      case "ws_ignore_all":
        return this.hashIgnoreAll(raw, ptr, end);
      case "ws_ignore_leading":
        return this.hashIgnoreLeading(raw, ptr, end);
      case "ws_ignore_trailing":
        return this.hashIgnoreTrailing(raw, ptr, end);
      case "ws_ignore_change":
        return this.hashIgnoreChange(raw, ptr, end);
    }
  }

  private hashDefault(raw: Uint8Array, ptr: number, end: number): number {
    let hash = 5381;
    for (; ptr < end; ptr++) {
      hash = ((hash << 5) + hash + raw[ptr]) | 0;
    }
    return hash;
  }

  private hashIgnoreAll(raw: Uint8Array, ptr: number, end: number): number {
    let hash = 5381;
    for (; ptr < end; ptr++) {
      const c = raw[ptr];
      if (!isWhitespace(c)) {
        hash = ((hash << 5) + hash + c) | 0;
      }
    }
    return hash;
  }

  private hashIgnoreLeading(raw: Uint8Array, ptr: number, end: number): number {
    let hash = 5381;
    ptr = trimLeadingWhitespace(raw, ptr, end);
    for (; ptr < end; ptr++) {
      hash = ((hash << 5) + hash + raw[ptr]) | 0;
    }
    return hash;
  }

  private hashIgnoreTrailing(raw: Uint8Array, ptr: number, end: number): number {
    let hash = 5381;
    end = trimTrailingWhitespace(raw, ptr, end);
    for (; ptr < end; ptr++) {
      hash = ((hash << 5) + hash + raw[ptr]) | 0;
    }
    return hash;
  }

  private hashIgnoreChange(raw: Uint8Array, ptr: number, end: number): number {
    let hash = 5381;
    end = trimTrailingWhitespace(raw, ptr, end);
    while (ptr < end) {
      let c = raw[ptr++];
      if (isWhitespace(c)) {
        ptr = trimLeadingWhitespace(raw, ptr, end);
        c = 0x20; // Replace with single space
      }
      hash = ((hash << 5) + hash + c) | 0;
    }
    return hash;
  }
}
