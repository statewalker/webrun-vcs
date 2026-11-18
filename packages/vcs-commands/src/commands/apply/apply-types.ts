/**
 * The patch model of `git apply` (apply.c's `struct patch` and `struct fragment`). Names and
 * contents are binary strings (one character per byte).
 */

/** Deflated binary delta hunk (`BINARY_DELTA_DEFLATED`). */
export const BINARY_DELTA = 1;
/** Deflated binary literal hunk (`BINARY_LITERAL_DEFLATED`). */
export const BINARY_LITERAL = 2;

/** One hunk: `@@ -oldpos,oldlines +newpos,newlines @@` and its lines. */
export interface PatchFragment {
  leading: number;
  trailing: number;
  oldpos: number;
  oldlines: number;
  newpos: number;
  newlines: number;
  /** The hunk text (a text hunk) or the inflated data (a binary hunk) */
  patch: string;
  size: number;
  linenr: number;
  rejected: boolean;
  /** A binary hunk's method ({@link BINARY_DELTA} or {@link BINARY_LITERAL}) */
  binaryMethod?: number;
}

/** The changes to one file. */
export interface FilePatch {
  defName: string | null;
  oldName: string | null;
  newName: string | null;
  /** 1 yes, 0 no, -1 not known yet */
  isNew: number;
  isDelete: number;
  isRename: boolean;
  isCopy: boolean;
  isBinary: boolean;
  isToplevelRelative: boolean;
  inaccurateEof: boolean;
  recount: boolean;
  crlfInOld: boolean;
  oldMode: number;
  newMode: number;
  score: number;
  wsRule: number;
  linesAdded: number;
  linesDeleted: number;
  extensionLinenr: number;
  oldOidPrefix: string;
  newOidPrefix: string;
  fragments: PatchFragment[];
  rejected: boolean;
  result?: string;
  directToThreeway: boolean;
  conflictedThreeway: boolean;
  /** Stages 1-3 of a conflicted three-way merge (null: none) */
  threewayStage: [string | null, string | null, string | null];
}

export function newFilePatch(): FilePatch {
  return {
    defName: null,
    oldName: null,
    newName: null,
    isNew: -1,
    isDelete: -1,
    isRename: false,
    isCopy: false,
    isBinary: false,
    isToplevelRelative: false,
    inaccurateEof: false,
    recount: false,
    crlfInOld: false,
    oldMode: 0,
    newMode: 0,
    score: 0,
    wsRule: 0,
    linesAdded: 0,
    linesDeleted: 0,
    extensionLinenr: 0,
    oldOidPrefix: "",
    newOidPrefix: "",
    fragments: [],
    rejected: false,
    directToThreeway: false,
    conflictedThreeway: false,
    threewayStage: [null, null, null],
  };
}

export const S_IFMT = 0o170000;
export const S_IFREG = 0o100000;
export const S_IFLNK = 0o120000;
export const S_IFDIR = 0o040000;
export const S_IFGITLINK = 0o160000;

export const isLink = (mode: number) => (mode & S_IFMT) === S_IFLNK;
export const isGitlink = (mode: number) => (mode & S_IFMT) === S_IFGITLINK;
export const isRegular = (mode: number) => (mode & S_IFMT) === S_IFREG;

/** `canon_mode`: a regular file 644 or 755, a link, a directory or a gitlink. */
export function canonMode(mode: number): number {
  const type = mode & S_IFMT;
  if (type === S_IFREG) return S_IFREG | (mode & 0o100 ? 0o755 : 0o644);
  if (type === S_IFLNK) return S_IFLNK;
  if (type === S_IFDIR) return S_IFDIR;
  return S_IFGITLINK;
}

/** How whitespace errors are treated (`--whitespace`). */
export type WsErrorAction = "nowarn" | "warn" | "error" | "fix";
