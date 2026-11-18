import { describe, expect, it } from "vitest";

import {
  abbreviate,
  type FetchRefUpdate,
  fetchRefcolWidth,
  fetchUpdateDisplay,
  formatFetchDisplay,
  formatPushStatus,
  type PushRefUpdate,
  prettifyRefName,
  transportSummaryWidth,
  ZERO_OID,
} from "../../src/index.js";

const A = `a${"1".repeat(39)}`;
const B = `b${"2".repeat(39)}`;

describe("summary widths and abbreviations (transport_summary_width)", () => {
  it("twice the longest abbreviation plus 3; 17 for none", () => {
    const lengths = new Map([
      [A, 9],
      [B, 7],
    ]);
    expect(transportSummaryWidth([A, B], lengths)).toBe(21);
    expect(transportSummaryWidth([])).toBe(17);
    expect(abbreviate(A, lengths)).toBe(A.slice(0, 9));
    expect(abbreviate(B)).toBe(B.slice(0, 7));
    expect(prettifyRefName("refs/remotes/origin/main")).toBe("origin/main");
    expect(prettifyRefName("refs/notes/x")).toBe("refs/notes/x");
  });
});

describe("formatFetchDisplay (display_ref_update)", () => {
  const update = (u: Partial<FetchRefUpdate>): FetchRefUpdate => ({
    remoteRef: "refs/heads/main",
    localRef: "refs/remotes/origin/main",
    newOid: B,
    status: "new",
    summary: "[new branch]",
    ...u,
  });
  it("full and compact formats, codes and details", () => {
    const entries = [
      update({}),
      update({
        remoteRef: "refs/heads/dev",
        localRef: "refs/remotes/origin/dev",
        oldOid: A,
        status: "forced",
        summary: `+ ${A.slice(0, 7)}...${B.slice(0, 7)}`,
      }),
      update({
        remoteRef: "refs/tags/v1",
        localRef: "refs/tags/v1",
        oldOid: A,
        status: "forced",
        summary: "[tag update]",
      }),
      update({ oldOid: B, status: "up-to-date", summary: "[up to date]" }),
    ].flatMap((u) => fetchUpdateDisplay(u) ?? []);
    expect(formatFetchDisplay(entries, { url: "https://u:p@example.com/r.git/" })).toEqual([
      "From https://example.com/r",
      " * [new branch]      main       -> origin/main",
      ` + ${A.slice(0, 7)}...${B.slice(0, 7)} dev        -> origin/dev  (forced update)`,
      " t [tag update]      v1         -> v1",
    ]);
    expect(formatFetchDisplay(entries, { url: "/srv/r", compact: true })).toEqual([
      "From /srv/r",
      " * [new branch]      main       -> origin/*",
      ` + ${A.slice(0, 7)}...${B.slice(0, 7)} dev        -> origin/*  (forced update)`,
      " t [tag update]      v1         -> *",
    ]);
    expect(fetchRefcolWidth([{ remote: "refs/heads/a-long-branch-name", local: "x" }])).toBe(18);
  });
});

describe("formatPushStatus (transport_print_push_status)", () => {
  const update = (u: Partial<PushRefUpdate>): PushRefUpdate => ({
    remoteRef: "refs/heads/main",
    localRef: "refs/heads/main",
    oldOid: A,
    newOid: B,
    force: false,
    status: "ok",
    forced: false,
    summary: "",
    ...u,
  });
  it("pushed refs first, then refused ones, each in the remote's order", () => {
    const lines = formatPushStatus(
      {
        remoteRefs: [
          { name: "refs/heads/gone", oid: A },
          { name: "refs/heads/main", oid: A },
        ],
        updates: [
          update({ remoteRef: "refs/heads/topic", localRef: "refs/heads/topic", oldOid: ZERO_OID }),
          update({ status: "rejected-fetch-first" }),
          update({ remoteRef: "refs/heads/gone", localRef: undefined, newOid: ZERO_OID }),
        ],
      },
      { dest: "https://user@example.com/r.git" },
    );
    expect(lines).toEqual([
      "To https://example.com/r.git",
      " - [deleted]         gone",
      " * [new branch]      topic -> topic",
      " ! [rejected]        main -> main (fetch first)",
    ]);
    expect(
      formatPushStatus(
        { remoteRefs: [], updates: [update({ oldOid: B, status: "up-to-date" })] },
        { dest: "/r" },
      ),
    ).toEqual(["Everything up-to-date"]);
  });
});
