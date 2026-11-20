import { createMemoryHistoryWithOperations, FileMode } from "@statewalker/vcs-core";
import type { Output } from "./output";

export default async function objectModel(out: Output) {
  const history = createMemoryHistoryWithOperations();
  await history.initialize();

  // A blob, a tree holding it, a commit of that tree: Git's object model.
  const blob = await history.blobs.store([new TextEncoder().encode("hello\n")]);
  const tree = await history.trees.store([
    { mode: FileMode.REGULAR_FILE, name: "hello.txt", id: blob },
  ]);
  const who = { name: "Ada", email: "ada@example.com", timestamp: 1700000000, tzOffset: "+0000" };
  const commit = await history.commits.store({
    tree,
    parents: [],
    author: who,
    committer: who,
    message: "Say hello\n",
  });

  // Each object as Git keeps it in .git/objects: zlib("<type> <size>\0<content>").
  // The page undoes the zlib with the browser's own DecompressionStream and hashes the result
  // with Web Crypto: if the SHA-1 equals the id, the bytes are Git's bytes.
  for (const [label, id] of [
    ["blob", blob],
    ["tree", tree],
    ["commit", commit],
  ] as const) {
    const loose = await collect(history.serialization.serializeLooseObject(id));
    const raw = await inflate(loose);
    const sha1 = hex(await crypto.subtle.digest("SHA-1", raw));
    out.log(`${label} ${id}`);
    out.log(`  .git/objects/${id.slice(0, 2)}/${id.slice(2)}  (${loose.length} bytes, zlib)`);
    out.log(`  inflated:  ${printable(raw)}`);
    out.log(`  SHA-1 of the inflated bytes: ${sha1}  ${sha1 === id ? "= id ✓" : "≠ id ✗"}`);
    if (sha1 !== id) throw new Error(`${label}: SHA-1 ${sha1} is not the id ${id}`);
    out.log("");
  }

  // `printf 'hello\n' | git hash-object --stdin` prints the same id.
  const gitHashObject = "ce013625030ba8dba906f756967f9e9ca394464a";
  out.log(`git hash-object of "hello\\n": ${gitHashObject}  ${blob === gitHashObject ? "✓" : "✗"}`);
  if (blob !== gitHashObject) throw new Error("the blob id differs from git hash-object's");
}

async function collect(chunks: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const chunk of chunks) parts.push(chunk);
  return new Uint8Array(await new Blob(parts as BlobPart[]).arrayBuffer());
}

async function inflate(bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  const stream = new Blob([bytes as BlobPart])
    .stream()
    .pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const hex = (buffer: ArrayBuffer) =>
  [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** Text as it is, NUL as \0, newlines as \n, other bytes (a tree's binary ids) as \xNN. */
const printable = (bytes: Uint8Array) =>
  [...bytes]
    .map((b) =>
      b === 0
        ? "\\0"
        : b === 10
          ? "\\n"
          : b >= 32 && b < 127
            ? String.fromCharCode(b)
            : `\\x${b.toString(16).padStart(2, "0")}`,
    )
    .join("");
