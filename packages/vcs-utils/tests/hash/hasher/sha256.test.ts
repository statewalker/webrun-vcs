import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { bytesToHex, createSha256 } from "../../../src/hash/index.js";

const enc = new TextEncoder();

function nodeSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe("createSha256", () => {
  it("matches the NIST FIPS 180-4 vectors", () => {
    expect(bytesToHex(createSha256().digest())).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(bytesToHex(createSha256().update(enc.encode("abc")).digest())).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(
      bytesToHex(
        createSha256()
          .update(enc.encode("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"))
          .digest(),
      ),
    ).toBe("248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1");
    expect(
      bytesToHex(
        createSha256()
          .update(
            enc.encode(
              "abcdefghbcdefghicdefghijdefghijkefghijklfghijklmghijklmnhijklmnoijklmnopjklmnopqklmnopqrlmnopqrsmnopqrstnopqrstu",
            ),
          )
          .digest(),
      ),
    ).toBe("cf5b16a778af8380036ce59e7b0492370b249b11e8f07a51afac45037afee9d1");
  });

  it("matches the one-million-'a' vector fed in 1000-byte pieces", () => {
    const h = createSha256();
    const block = new Uint8Array(1000).fill(0x61);
    for (let i = 0; i < 1000; i++) h.update(block);
    expect(bytesToHex(h.digest())).toBe(
      "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0",
    );
  });

  it("gives Node's digest for a split at every offset within one 64-byte block", () => {
    // Lengths around one and two blocks, including the padding edge cases 55, 56, 63, 64.
    for (const len of [55, 56, 63, 64, 65, 119, 120, 128, 191]) {
      const data = new Uint8Array(randomBytes(len));
      const expected = nodeSha256(data);
      for (let cut = 0; cut <= 64 && cut <= len; cut++) {
        const h = createSha256().update(data.subarray(0, cut)).update(data.subarray(cut));
        expect(bytesToHex(h.digest()), `len=${len} cut=${cut}`).toBe(expected);
        // Two cuts: a short piece inside the next block as well
        const second = Math.min(len, cut + 7);
        const h2 = createSha256()
          .update(data.subarray(0, cut))
          .update(data.subarray(cut, second))
          .update(data.subarray(second));
        expect(bytesToHex(h2.digest()), `len=${len} cuts=${cut},${second}`).toBe(expected);
      }
    }
  });

  it("gives Node's digest for multi-megabyte inputs in uneven chunks", () => {
    const data = new Uint8Array(randomBytes(6 * 1024 * 1024 + 13));
    const h = createSha256();
    let at = 0;
    let step = 1;
    while (at < data.length) {
      const end = Math.min(data.length, at + step);
      h.update(data.subarray(at, end));
      at = end;
      step = (step * 7 + 4093) % 300_007;
    }
    expect(bytesToHex(h.digest())).toBe(nodeSha256(data));
  });

  it("clones an intermediate state and is spent after digest", () => {
    const h = createSha256().update(enc.encode("Hello"));
    const branch = h.clone().update(enc.encode(" Universe"));
    h.update(enc.encode(" World"));
    expect(bytesToHex(h.digest())).toBe(nodeSha256(enc.encode("Hello World")));
    expect(bytesToHex(branch.digest())).toBe(nodeSha256(enc.encode("Hello Universe")));
    expect(() => h.digest()).toThrow(/already digested/);
    expect(() => h.update(enc.encode("x"))).toThrow(/already digested/);
  });
});
