/**
 * Git objects written by git 2.43 (`git hash-object`, `mktree`, `commit-tree`,
 * `mktag`), as raw loose objects (`"<type> <size>\0" + content`) in base64.
 * They cover what a parser would lose: legacy tree modes, gpgsig and mergetag
 * headers, unknown headers, Latin-1 bytes, odd time zones, empty bodies.
 */
export interface GitObjectSample {
  name: string;
  id: string;
  type: "blob" | "tree" | "commit" | "tag";
  raw: Uint8Array;
}

const SAMPLES: { name: string; id: string; type: GitObjectSample["type"]; raw: string }[] = [
  {
    name: "blob: empty",
    id: "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391",
    type: "blob",
    raw: "YmxvYiAwAA==",
  },
  {
    name: "blob: text",
    id: "ce013625030ba8dba906f756967f9e9ca394464a",
    type: "blob",
    raw: "YmxvYiA2AGhlbGxvCg==",
  },
  {
    name: "blob: every byte value",
    id: "c8b49c8cd518e58491924bfc364ff26e01a85009",
    type: "blob",
    raw: "YmxvYiAxMDI0AAABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4fICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj9AQUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVpbXF1eX2BhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ent8fX5/gIGCg4SFhoeIiYqLjI2Oj5CRkpOUlZaXmJmam5ydnp+goaKjpKWmp6ipqqusra6vsLGys7S1tre4ubq7vL2+v8DBwsPExcbHyMnKy8zNzs/Q0dLT1NXW19jZ2tvc3d7f4OHi4+Tl5ufo6err7O3u7/Dx8vP09fb3+Pn6+/z9/v8AAQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyAhIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzg5Ojs8PT4/QEFCQ0RFRkdISUpLTE1OT1BRUlNUVVZXWFlaW1xdXl9gYWJjZGVmZ2hpamtsbW5vcHFyc3R1dnd4eXp7fH1+f4CBgoOEhYaHiImKi4yNjo+QkZKTlJWWl5iZmpucnZ6foKGio6SlpqeoqaqrrK2ur7CxsrO0tba3uLm6u7y9vr/AwcLDxMXGx8jJysvMzc7P0NHS09TV1tfY2drb3N3e3+Dh4uPk5ebn6Onq6+zt7u/w8fLz9PX29/j5+vv8/f7/AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8gISIjJCUmJygpKissLS4vMDEyMzQ1Njc4OTo7PD0+P0BBQkNERUZHSElKS0xNTk9QUVJTVFVWV1hZWltcXV5fYGFiY2RlZmdoaWprbG1ub3BxcnN0dXZ3eHl6e3x9fn+AgYKDhIWGh4iJiouMjY6PkJGSk5SVlpeYmZqbnJ2en6ChoqOkpaanqKmqq6ytrq+wsbKztLW2t7i5uru8vb6/wMHCw8TFxsfIycrLzM3Oz9DR0tPU1dbX2Nna29zd3t/g4eLj5OXm5+jp6uvs7e7v8PHy8/T19vf4+fr7/P3+/wABAgMEBQYHCAkKCwwNDg8QERITFBUWFxgZGhscHR4fICEiIyQlJicoKSorLC0uLzAxMjM0NTY3ODk6Ozw9Pj9AQUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVpbXF1eX2BhYmNkZWZnaGlqa2xtbm9wcXJzdHV2d3h5ent8fX5/gIGCg4SFhoeIiYqLjI2Oj5CRkpOUlZaXmJmam5ydnp+goaKjpKWmp6ipqqusra6vsLGys7S1tre4ubq7vL2+v8DBwsPExcbHyMnKy8zNzs/Q0dLT1NXW19jZ2tvc3d7f4OHi4+Tl5ufo6err7O3u7/Dx8vP09fb3+Pn6+/z9/v8=",
  },
  {
    name: "blob: CRLF text without final newline",
    id: "f1f3fabacef2a7eed3e22d9ca7e18140db5e801d",
    type: "blob",
    raw: "YmxvYiAzMABsaW5lIG9uZQ0KbGluZSB0d28NCm5vIG5ld2xpbmU=",
  },
  {
    name: "tree: one entry",
    id: "66c31ab1b81cb3c5a77682b67611d2d6984ba73d",
    type: "tree",
    raw: "dHJlZSAzNwAxMDA2NDQgaW5uZXIudHh0AM4BNiUDC6jbqQb3VpZ/npyjlEZK",
  },
  {
    name: "tree: all modes, non-ASCII name",
    id: "1cf17be12bcd7c82f27954f8894d98d33bf41b5d",
    type: "tree",
    raw: "dHJlZSAyMTkAMTAwNjQ0IFJFQURNRQDOATYlAwuo26kG91aWf56co5RGSjEyMDAwMCBsaW5rAM4BNiUDC6jbqQb3VpZ/npyjlEZKMTAwNjQ0IG5hw692ZSBuYW1lIHdpdGggc3BhY2VzLnR4dADOATYlAwuo26kG91aWf56co5RGSjEwMDc1NSBydW4uc2gA5p3im7LR1kNLiymud1rYwuSMU5E0MDAwMCBzcmMAZsMasbgcs8WndoK2dhHS1phLpz0xNjAwMDAgdmVuZG9yABERERERERERERERERERERERERER",
  },
  {
    name: "tree: zero-padded mode 040000 (old tools)",
    id: "96fff523445da1bd1d6c30f5df0bbc4aaa801742",
    type: "tree",
    raw: "dHJlZSA2MAAwNDAwMDAgc3JjAGbDGrG4HLPFp3aCtnYR0taYS6c9MTAwNjQ0IHoAzgE2JQMLqNupBvdWln+enKOURko=",
  },
  {
    name: "tree: group-writable mode 100664 (git < 1.0)",
    id: "bfd19982b637183cb0af72e0e43dac1112a971b1",
    type: "tree",
    raw: "dHJlZSAyOQAxMDA2NjQgYQDOATYlAwuo26kG91aWf56co5RGSg==",
  },
  {
    name: "tree: empty",
    id: "4b825dc642cb6eb9a060e54bf8d69288fbee4904",
    type: "tree",
    raw: "dHJlZSAwAA==",
  },
  {
    name: "commit: root",
    id: "2056d6a3261ff3b9581c2907ffe4feeec8e623df",
    type: "commit",
    raw: "Y29tbWl0IDE3NQB0cmVlIDFjZjE3YmUxMmJjZDdjODJmMjc5NTRmODg5NGQ5OGQzM2JmNDFiNWQKYXV0aG9yIEEgVSBUaG9yIDxhdXRob3JAZXhhbXBsZS5jb20+IDE3MDAwMDAwMDAgKzAyMDAKY29tbWl0dGVyIEMgTyBNaXR0ZXIgPGNvbW1pdHRlckBleGFtcGxlLmNvbT4gMTcwMDAwMDEwMCAtMDEzMAoKcm9vdCBjb21taXQK",
  },
  {
    name: "commit: one parent, body",
    id: "4db52fae9a9968485f658713651e86470a030574",
    type: "commit",
    raw: "Y29tbWl0IDIyOQB0cmVlIDY2YzMxYWIxYjgxY2IzYzVhNzc2ODJiNjc2MTFkMmQ2OTg0YmE3M2QKcGFyZW50IDIwNTZkNmEzMjYxZmYzYjk1ODFjMjkwN2ZmZTRmZWVlYzhlNjIzZGYKYXV0aG9yIEEgVSBUaG9yIDxhdXRob3JAZXhhbXBsZS5jb20+IDE3MDAwMDAwMDAgKzAyMDAKY29tbWl0dGVyIEMgTyBNaXR0ZXIgPGNvbW1pdHRlckBleGFtcGxlLmNvbT4gMTcwMDAwMDEwMCAtMDEzMAoKc2Vjb25kCgp3aXRoIGJvZHkK",
  },
  {
    name: "commit: merge",
    id: "a87ee30d366b7573ee3bd0f5f14e30cc90b98f50",
    type: "commit",
    raw: "Y29tbWl0IDI2NQB0cmVlIDFjZjE3YmUxMmJjZDdjODJmMjc5NTRmODg5NGQ5OGQzM2JmNDFiNWQKcGFyZW50IDIwNTZkNmEzMjYxZmYzYjk1ODFjMjkwN2ZmZTRmZWVlYzhlNjIzZGYKcGFyZW50IDRkYjUyZmFlOWE5OTY4NDg1ZjY1ODcxMzY1MWU4NjQ3MGEwMzA1NzQKYXV0aG9yIEEgVSBUaG9yIDxhdXRob3JAZXhhbXBsZS5jb20+IDE3MDAwMDAwMDAgKzAyMDAKY29tbWl0dGVyIEMgTyBNaXR0ZXIgPGNvbW1pdHRlckBleGFtcGxlLmNvbT4gMTcwMDAwMDEwMCAtMDEzMAoKbWVyZ2UK",
  },
  {
    name: "commit: gpgsig continuation header",
    id: "7ff225babebedec5ec8c0611b228a9e508073864",
    type: "commit",
    raw: "Y29tbWl0IDM0NAB0cmVlIDFjZjE3YmUxMmJjZDdjODJmMjc5NTRmODg5NGQ5OGQzM2JmNDFiNWQKcGFyZW50IDIwNTZkNmEzMjYxZmYzYjk1ODFjMjkwN2ZmZTRmZWVlYzhlNjIzZGYKYXV0aG9yIEEgVSBUaG9yIDxhdXRob3JAZXhhbXBsZS5jb20+IDE3MDAwMDAwMDAgKzAyMDAKY29tbWl0dGVyIEEgVSBUaG9yIDxhdXRob3JAZXhhbXBsZS5jb20+IDE3MDAwMDAwMDAgKzAyMDAKZ3Bnc2lnIC0tLS0tQkVHSU4gUEdQIFNJR05BVFVSRS0tLS0tCiAKIGlRRXpCQUFCQ0FBZEZpRUUwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwMDAwQUFBQQogPWFiY2QKIC0tLS0tRU5EIFBHUCBTSUdOQVRVUkUtLS0tLQoKc2lnbmVkCg==",
  },
  {
    name: "commit: mergetag header",
    id: "007a26b9347a58b1c9ddaf728015beb2ab39c7b1",
    type: "commit",
    raw: "Y29tbWl0IDQwNgB0cmVlIDFjZjE3YmUxMmJjZDdjODJmMjc5NTRmODg5NGQ5OGQzM2JmNDFiNWQKcGFyZW50IDIwNTZkNmEzMjYxZmYzYjk1ODFjMjkwN2ZmZTRmZWVlYzhlNjIzZGYKcGFyZW50IDRkYjUyZmFlOWE5OTY4NDg1ZjY1ODcxMzY1MWU4NjQ3MGEwMzA1NzQKYXV0aG9yIEEgVSBUaG9yIDxhdXRob3JAZXhhbXBsZS5jb20+IDE3MDAwMDAwMDAgKzAyMDAKY29tbWl0dGVyIEEgVSBUaG9yIDxhdXRob3JAZXhhbXBsZS5jb20+IDE3MDAwMDAwMDAgKzAyMDAKbWVyZ2V0YWcgb2JqZWN0IDRkYjUyZmFlOWE5OTY4NDg1ZjY1ODcxMzY1MWU4NjQ3MGEwMzA1NzQKIHR5cGUgY29tbWl0CiB0YWcgdjEKIHRhZ2dlciBBIFUgVGhvciA8YXV0aG9yQGV4YW1wbGUuY29tPiAxNzAwMDAwMDAwICswMjAwCiAKIHYxCgptZXJnZSB0YWcgdjEK",
  },
  {
    name: "commit: ISO-8859-1 encoding, Latin-1 bytes",
    id: "55fd39d136cc952733d23fdf4793d5c5ec56b5fd",
    type: "commit",
    raw: "Y29tbWl0IDE4MwB0cmVlIDFjZjE3YmUxMmJjZDdjODJmMjc5NTRmODg5NGQ5OGQzM2JmNDFiNWQKYXV0aG9yIEEgVSBUaG9yIDxhdXRob3JAZXhhbXBsZS5jb20+IDE3MDAwMDAwMDAgKzAyMDAKY29tbWl0dGVyIEEgVSBUaG9yIDxhdXRob3JAZXhhbXBsZS5jb20+IDE3MDAwMDAwMDAgKzAyMDAKZW5jb2RpbmcgSVNPLTg4NTktMQoKY2Fm6Qo=",
  },
  {
    name: "commit: unknown header, no final newline",
    id: "da2dc15bc43ec6267bf919f33177749aec408d01",
    type: "commit",
    raw: "Y29tbWl0IDE4OAB0cmVlIDFjZjE3YmUxMmJjZDdjODJmMjc5NTRmODg5NGQ5OGQzM2JmNDFiNWQKYXV0aG9yIEEgVSBUaG9yIDxhdXRob3JAZXhhbXBsZS5jb20+IDE3MDAwMDAwMDAgKzAyMDAKY29tbWl0dGVyIEEgVSBUaG9yIDxhdXRob3JAZXhhbXBsZS5jb20+IDE3MDAwMDAwMDAgKzAyMDAKeC1jdXN0b20gc29tZSB2YWx1ZQoKbm8gbmV3bGluZQ==",
  },
  {
    name: "commit: empty message",
    id: "78ee42b26da224b317fd4db34632f2b2689840af",
    type: "commit",
    raw: "Y29tbWl0IDE1OAB0cmVlIDFjZjE3YmUxMmJjZDdjODJmMjc5NTRmODg5NGQ5OGQzM2JmNDFiNWQKYXV0aG9yIEEgVSBUaG9yIDxhdXRob3JAZXhhbXBsZS5jb20+IDE3MDAwMDAwMDAgKzAyMDAKY29tbWl0dGVyIEEgVSBUaG9yIDxhdXRob3JAZXhhbXBsZS5jb20+IDE3MDAwMDAwMDAgKzAyMDAKCg==",
  },
  {
    name: "commit: odd time zone, missing space before email",
    id: "1bb02fa49489ab29c35f78832085deab69f441ad",
    type: "commit",
    raw: "Y29tbWl0IDEwNAB0cmVlIDFjZjE3YmUxMmJjZDdjODJmMjc5NTRmODg5NGQ5OGQzM2JmNDFiNWQKYXV0aG9yIE5hbWU8YUBiPiAwICsxMzQ1CmNvbW1pdHRlciBOYW1lPGFAYj4gMCAtMDAwMAoKb2RkCg==",
  },
  {
    name: "tag: annotated",
    id: "dc0519c42a6a77fcc0db728845cc3b4605967a3c",
    type: "tag",
    raw: "dGFnIDEzNgBvYmplY3QgMjA1NmQ2YTMyNjFmZjNiOTU4MWMyOTA3ZmZlNGZlZWVjOGU2MjNkZgp0eXBlIGNvbW1pdAp0YWcgdjEuMAp0YWdnZXIgQSBVIFRob3IgPGF1dGhvckBleGFtcGxlLmNvbT4gMTcwMDAwMDAwMCArMDIwMAoKcmVsZWFzZSAxLjAK",
  },
  {
    name: "tag: legacy, no tagger",
    id: "1257020a4c4a10f7fd3750638d8831002ca16c0c",
    type: "tag",
    raw: "dGFnIDc3AG9iamVjdCBjZTAxMzYyNTAzMGJhOGRiYTkwNmY3NTY5NjdmOWU5Y2EzOTQ0NjRhCnR5cGUgYmxvYgp0YWcgb2xkCgpmcm9tIDIwMDUK",
  },
];

/** The sample objects, decoded (works in browsers, Node and workers: no Buffer). */
export function gitObjectSamples(): GitObjectSample[] {
  return SAMPLES.map((o) => ({ ...o, raw: Uint8Array.from(atob(o.raw), (c) => c.charCodeAt(0)) }));
}
