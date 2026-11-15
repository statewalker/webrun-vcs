/**
 * FETCH_HEAD as git writes it (fetch.c append_fetch_head): the lines, their order, the
 * ref descriptions and the URL shown.
 */

import { describe, expect, it } from "vitest";

import {
  anonymizeUrl,
  fetchHeadUrl,
  formatFetchHead,
  parseFetchHead,
} from "../../src/fetch-client/index.js";

const A = "a".repeat(40);
const B = "b".repeat(40);

describe("formatFetchHead", () => {
  it("writes the refs to merge first, then the others, each in the given order", () => {
    const text = formatFetchHead(
      [
        { oid: A, remoteRef: "refs/heads/feature", notForMerge: true },
        { oid: B, remoteRef: "refs/heads/main", notForMerge: false },
        { oid: A, remoteRef: "refs/tags/v1", notForMerge: true },
        { oid: B, remoteRef: "refs/remotes/origin/x", notForMerge: true },
        { oid: B, remoteRef: "refs/notes/commits", notForMerge: true },
      ],
      "https://example.com/repo.git/",
    );
    expect(text).toBe(
      `${B}\t\tbranch 'main' of https://example.com/repo\n` +
        `${A}\tnot-for-merge\tbranch 'feature' of https://example.com/repo\n` +
        `${A}\tnot-for-merge\ttag 'v1' of https://example.com/repo\n` +
        `${B}\tnot-for-merge\tremote-tracking branch 'origin/x' of https://example.com/repo\n` +
        `${B}\tnot-for-merge\t'refs/notes/commits' of https://example.com/repo\n`,
    );
  });

  it("describes the remote HEAD by the URL alone, and reads back what it writes", () => {
    const text = formatFetchHead([{ oid: A, remoteRef: "HEAD", notForMerge: false }], "../src");
    expect(text).toBe(`${A}\t\t../src\n`);
    expect(parseFetchHead(text)).toEqual([{ oid: A, notForMerge: false, description: "../src" }]);
  });
});

describe("the URL FETCH_HEAD shows", () => {
  it("drops credentials as git's transport_anonymize_url does", () => {
    expect(anonymizeUrl("https://user:secret@example.com/r.git")).toBe("https://example.com/r.git");
    expect(anonymizeUrl("git@github.com:org/repo.git")).toBe("github.com:org/repo.git");
    expect(anonymizeUrl("https://example.com/a@b/r.git")).toBe("https://example.com/a@b/r.git");
    expect(anonymizeUrl("/srv/me@host/repo")).toBe("/srv/me@host/repo");
  });

  it("drops trailing slashes and a final .git", () => {
    expect(fetchHeadUrl("https://u:p@example.com/repo.git//")).toBe("https://example.com/repo");
    expect(fetchHeadUrl("/srv/repo.git")).toBe("/srv/repo");
    expect(fetchHeadUrl("x.git")).toBe("x.git");
  });
});
