/**
 * Native twins of the plumbing diffs: `git diff-tree`/`diff-index`/`diff-files` argv mapped
 * onto {@link DiffTreeCommand}, {@link DiffIndexCommand} and {@link DiffFilesCommand}.
 */
import { execFileSync } from "node:child_process";

import type { DiffOutputFormat, DiffTextOptions, DiffTreeMerges, Git } from "../src/index.js";

/** Native git's stdout (bytes as latin1), its stderr and status */
export interface NativeRun {
  stdout: string;
  stderr: string;
  status: number;
}

/** Native git run in `cwd`, never throwing */
export function runNative(
  cwd: string,
  env: Record<string, string>,
  args: string[],
  input?: string,
): NativeRun {
  try {
    const stdout = execFileSync("git", args, {
      cwd,
      env,
      encoding: "latin1",
      input: input ?? "",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { stdout, stderr: "", status: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return { stdout: err.stdout ?? "", stderr: err.stderr ?? "", status: err.status ?? 1 };
  }
}

/** Ours for the same argv: stdout as latin1 (git's bytes), or the error's exit status */
export async function runOurs(git: Git, args: string[], input?: string): Promise<NativeRun> {
  try {
    const bytes = await oursCommand(git, args, input);
    return { stdout: Buffer.from(bytes).toString("latin1"), stderr: "", status: 0 };
  } catch (e) {
    const err = e as { message?: string; exitCode?: number };
    return { stdout: "", stderr: `${err.message ?? e}\n`, status: err.exitCode ?? 128 };
  }
}

function oursCommand(git: Git, argv: string[], input?: string): Promise<Uint8Array> {
  const [name, ...args] = argv;
  const formats: DiffOutputFormat[] = [];
  const options: DiffTextOptions = {};
  const positional: string[] = [];
  const paths: string[] = [];
  let abbrev: number | true | undefined;
  let z = false;
  let recursive = false;
  let showTrees = false;
  let root = false;
  let stdin = false;
  let merges: DiffTreeMerges = "none";
  let cached = false;
  let noCommitId = false;
  let pretty: string | undefined;
  let dashdash = false;
  for (const arg of args) {
    if (dashdash) {
      paths.push(arg);
      continue;
    }
    if (arg === "--") dashdash = true;
    else if (arg === "-r") recursive = true;
    else if (arg === "-t") showTrees = true;
    else if (arg === "--root") root = true;
    else if (arg === "--stdin") stdin = true;
    else if (arg === "-m") merges = "separate";
    else if (arg === "-c") merges = "combined";
    else if (arg === "--cc") merges = "dense-combined";
    else if (arg === "-z") z = true;
    else if (arg === "--abbrev") abbrev = true;
    else if (arg.startsWith("--abbrev=")) abbrev = Number(arg.slice(9));
    else if (arg === "-R") options.reverse = true;
    else if (arg === "-p" || arg === "-u" || arg === "--patch") formats.push("patch");
    else if (arg === "--raw") formats.push("raw");
    else if (arg === "--stat") formats.push("stat");
    else if (arg === "--numstat") formats.push("numstat");
    else if (arg === "--shortstat") formats.push("shortstat");
    else if (arg === "--summary") formats.push("summary");
    else if (arg === "--name-only") formats.push("name-only");
    else if (arg === "--name-status") formats.push("name-status");
    else if (arg === "--patch-with-raw") formats.push("raw", "patch");
    else if (arg === "--patch-with-stat") formats.push("stat", "patch");
    else if (arg === "--full-index") options.fullIndex = true;
    else if (arg === "--find-copies-harder") options.findCopiesHarder = true;
    else if (arg === "-M") options.findRenames = true;
    else if (arg === "-C") {
      if (options.findCopies) options.findCopiesHarder = true;
      options.findCopies = true;
    } else if (arg === "-B") options.breakRewrites = true;
    else if (arg.startsWith("--diff-filter=")) options.diffFilter = arg.slice(14);
    else if (arg === "--cached") cached = true;
    else if (arg === "--no-commit-id") noCommitId = true;
    else if (arg === "--pretty") pretty = "medium";
    else if (arg.startsWith("--pretty=")) pretty = arg.slice(9);
    else if (arg.startsWith("--format=")) pretty = `format:${arg.slice(9)}`;
    else if (arg.startsWith("-")) throw new Error(`unmapped option ${arg}`);
    else positional.push(arg);
  }
  const common = <
    T extends {
      setFormats(f: DiffOutputFormat[]): T;
      setOptions(o: DiffTextOptions): T;
      setPathspec(p: string[]): T;
      setAbbrev(n?: number): T;
      setNullTerminated(z: boolean): T;
    },
  >(
    command: T,
  ): T => {
    if (formats.length > 0) command.setFormats(formats);
    command.setOptions(options);
    if (paths.length > 0) command.setPathspec(paths);
    if (abbrev !== undefined) command.setAbbrev(abbrev === true ? undefined : abbrev);
    if (z) command.setNullTerminated(true);
    return command;
  };
  if (name === "diff-tree") {
    const command = common(git.diffTree())
      .setRecursive(recursive)
      .setShowTrees(showTrees)
      .setRoot(root)
      .setMerges(merges)
      .setNoCommitId(noCommitId);
    if (pretty !== undefined) command.setPretty(pretty);
    for (const p of positional) command.addArgument(p);
    if (stdin) command.setStdin(input ?? "");
    return command.call();
  }
  if (name === "diff-index") {
    const command = common(git.diffIndex()).setCached(cached);
    const [tree, ...rest] = positional;
    if (tree !== undefined) command.setTree(tree);
    if (rest.length > 0) command.setPathspec([...rest, ...paths]);
    return command.call();
  }
  if (name === "diff-pairs") {
    const command = common(git.diffPairs()).setInput(input ?? "");
    if (positional.length > 0) command.setPathspec([...positional, ...paths]);
    return command.call();
  }
  if (name === "diff-files") {
    const command = common(git.diffFiles());
    if (positional.length > 0) command.setPathspec([...positional, ...paths]);
    return command.call();
  }
  throw new Error(`unmapped command ${name}`);
}

/**
 * t/lib-read-tree-m-3way.sh: the trees O, A and B of t1000's three-way matrix (files `NN`
 * ... `MM`, `Z/..`, `SS`, `TT`, `LL`, and `DF` a directory in A, a file in B), built with
 * plumbing; prints `tree_O tree_A tree_B` on its last line
 */
export const READ_TREE_3WAY = `
set -e
mkdir Z
for a in N D M; do for b in N D M; do
  p=$a$b
  echo This is $p from the original tree. >$p
  echo This is Z/$p from the original tree. >Z/$p
  git update-index --add $p
  git update-index --add Z/$p
done; done
echo This is SS from the original tree. >SS
git update-index --add SS
cat >TT <<\\EOF
This is a trivial merge sample text.
Branch A is expected to upcase this word, here.
There are some filler lines to avoid diff context
conflicts here,
like this one,
and this one,
and this one is yet another one of them.
At the very end, here comes another line, that is
the word, expected to be upcased by Branch B.
This concludes the trivial merge sample file.
EOF
git update-index --add TT
tree_O=$(git write-tree)
to_remove=$(echo D? Z/D?)
rm -f $to_remove
git update-index --remove $to_remove
for p in M? Z/M?; do echo This is modified $p in the branch A. >$p; git update-index $p; done
for p in AN AA Z/AN Z/AA; do echo This is added $p in the branch A. >$p; git update-index --add $p; done
echo This is SS from the modified tree. >SS
echo This is LL from the modified tree. >LL
git update-index --add LL
git update-index SS
mv TT TT-
sed -e '/Branch A/s/word/WORD/g' <TT- >TT
rm -f TT-
git update-index TT
mkdir DF
echo Branch A makes a file at DF/DF, creating a directory DF. >DF/DF
git update-index --add DF/DF
tree_A=$(git write-tree)
rm -rf [NDMASLT][NDMASLT] Z DF
mkdir Z
git read-tree $tree_O
git checkout-index -a
to_remove=$(echo ?D Z/?D)
rm -f $to_remove
git update-index --remove $to_remove
for p in ?M Z/?M; do echo This is modified $p in the branch B. >$p; git update-index $p; done
for p in NA AA Z/NA Z/AA; do echo This is added $p in the branch B. >$p; git update-index --add $p; done
echo This is SS from the modified tree. >SS
echo This is LL from the modified tree. >LL
git update-index --add LL
git update-index SS
mv TT TT-
sed -e '/Branch B/s/word/WORD/g' <TT- >TT
rm -f TT-
git update-index TT
echo Branch B makes a file at DF. >DF
git update-index --add DF
tree_B=$(git write-tree)
echo $tree_O $tree_A $tree_B
`;
