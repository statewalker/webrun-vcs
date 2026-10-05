/**
 * Converts an async stream of Uint8Array chunks into lines.
 * Handles both LF and CRLF line endings.
 *
 * @param input The input async iterable stream
 * @param keepDelimiter When true, each line preserves its trailing "\n".
 *   The last line omits "\n" only if the input did not end with one.
 *   Useful when byte-level round-trip fidelity is required
 *   (e.g. Git commit messages where trailing newline affects the hash).
 */
export async function* toLines(
  input: Iterable<Uint8Array> | AsyncIterable<Uint8Array>,
  keepDelimiter = false,
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = "";

  for await (const chunk of input) {
    buffer += decoder.decode(chunk, { stream: true });
    const parts = buffer.split("\n");
    // Keep the last partial segment in buffer
    buffer = parts.pop() || "";
    for (const part of parts) {
      yield keepDelimiter ? `${part}\n` : trimEnd(part, "\r");
    }
  }
  if (buffer.length > 0) {
    yield keepDelimiter ? buffer : trimEnd(buffer, "\r");
  }
}

function trimEnd(str: string, char: string[1]): string {
  return str.endsWith(char) ? str.slice(0, -char.length) : str;
}
