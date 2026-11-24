/**
 * The signer of Node hosts: runs the signing program the commands resolved (gpg, gpgsm,
 * ssh-keygen, or what `gpg.<format>.program` names) as git's gpg-interface.c runs it, and
 * hands back the signature or git's messages. Its shape is `Signer` of
 * `@statewalker/vcs-working-tree`; pass it to `createNodeGitHostEnvironment({ signer })`.
 *
 * The verifier of Node hosts (`createNodeVerifier`) lives here too: it runs gpg, gpgsm or
 * ssh-keygen as git's `check_signature` runs them.
 *
 * This is the one file of vcs-utils-node besides the hook runner that starts processes, and
 * the one that writes host files outside a FilesApi: ssh-keygen signs a file and writes the
 * signature beside it, so the payload (and a literal key) go to temporary files in the host's
 * temporary directory, as git's `mks_tempfile_t` puts them, never into the repository; a
 * signature to check goes to such a file too (`.git_vtag_tmp*`).
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

/** What to sign and how (`SigningRequest` of `@statewalker/vcs-working-tree`). */
export interface NodeSigningRequest {
  format: "openpgp" | "x509" | "ssh";
  payload: Uint8Array;
  key?: string;
  program: string;
  defaultKeyCommand?: string;
  cwd?: string;
}

/** What signing gave (`SigningOutcome`). */
export interface NodeSigningOutcome {
  signature?: Uint8Array;
  messages?: string[];
  died?: boolean;
  exitCode?: number;
}

/** The signer (`Signer`). */
export type NodeSigner = (request: NodeSigningRequest) => Promise<NodeSigningOutcome>;

/** How signing programs are run. */
export interface NodeSignerOptions {
  /** The variables the programs start with (default: `process.env`): `GNUPGHOME`, `SSH_AUTH_SOCK` */
  env?: Record<string, string | undefined>;
  /** Where a program runs when the request names no directory (default: the process's) */
  defaultCwd?: string;
  /** Where the temporary files of ssh signing go (default: `$TMPDIR`, else the OS's) */
  tmpdir?: string;
}

/**
 * A signer that runs the configured program as git does: openpgp and x509 as
 * `<program> --status-fd=2 -bsau <key>` (payload on stdin, signature on stdout, success only
 * with a `[GNUPG:] SIG_CREATED ` status line), ssh as `<program> -Y sign -n git -f <key file>
 * [-U] <payload file>` (signature from `<payload file>.sig`), the default ssh key from
 * `gpg.ssh.defaultKeyCommand`'s first line.
 *
 * @example
 * ```typescript
 * const environment = createNodeGitHostEnvironment({ signer: createNodeSigner() });
 * ```
 */
export function createNodeSigner(options: NodeSignerOptions = {}): NodeSigner {
  return (request) =>
    request.format === "ssh" ? signSsh(request, options) : signGpg(request, options);
}

interface RunResult {
  code: number;
  stdout: Buffer;
  stderr: Buffer;
  /** git's error when the program could not be started */
  startError?: string;
}

function environmentOf(options: NodeSignerOptions): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(options.env ?? process.env)) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** git's `pipe_command`: the program run with `stdin`, its outputs gathered. */
function run(
  args: string[],
  stdin: Uint8Array | undefined,
  cwd: string | undefined,
  options: NodeSignerOptions,
): Promise<RunResult> {
  const [program = "", ...rest] = args;
  if (program === "") {
    // an empty command line (an empty gpg.ssh.defaultKeyCommand): execvp of "" fails, which
    // start_command reports with no program name
    return Promise.resolve({
      code: -1,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      startError: "error: cannot run : No such file or directory",
    });
  }
  return new Promise((resolve) => {
    const child = spawn(program, rest, {
      cwd: cwd ?? options.defaultCwd ?? process.cwd(),
      env: environmentOf(options),
      stdio: [stdin ? "pipe" : "ignore", "pipe", "pipe"],
    });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let failed: NodeJS.ErrnoException | undefined;
    child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => err.push(chunk));
    child.on("error", (error) => {
      failed = error;
    });
    // git ignores SIGPIPE while it writes: a program that exits without reading fails instead
    child.stdin?.on("error", () => {});
    if (stdin && child.stdin) child.stdin.end(Buffer.from(stdin));
    child.on("close", (code) => {
      if (failed) {
        const reason = errnoText(failed);
        // start_command: a program found on PATH or not ("cannot run"), a path that cannot
        // be executed (the child's "cannot exec")
        const startError = program.includes("/")
          ? `error: cannot exec '${program}': ${reason}`
          : `error: cannot run ${program}: ${reason}`;
        resolve({ code: -1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0), startError });
        return;
      }
      resolve({ code: code ?? -1, stdout: Buffer.concat(out), stderr: Buffer.concat(err) });
    });
  });
}

function errnoText(error: NodeJS.ErrnoException): string {
  switch (error.code) {
    case "ENOENT":
      return "No such file or directory";
    case "EACCES":
      return "Permission denied";
    default:
      return error.message;
  }
}

/** gpg-interface.c's `sign_buffer_gpg`. */
async function signGpg(
  request: NodeSigningRequest,
  options: NodeSignerOptions,
): Promise<NodeSigningOutcome> {
  const result = await run(
    [request.program, "--status-fd=2", "-bsau", request.key ?? ""],
    request.payload,
    request.cwd,
    options,
  );
  const status = result.stderr.toString("utf8");
  const created = status.split("\n").some((line) => line.startsWith("[GNUPG:] SIG_CREATED "));
  if (result.code === 0 && created) return { signature: new Uint8Array(result.stdout) };
  const messages = result.startError ? [result.startError] : [];
  messages.push(`error: gpg failed to sign the data:\n${status || "(no gpg output)"}`);
  return { messages };
}

/** `key::<key>` or a key starting `ssh-` (git's `is_literal_ssh_key`): the key, else undefined. */
function literalSshKey(key: string): string | undefined {
  if (key.startsWith("key::")) return key.slice(5);
  if (key.startsWith("ssh-")) return key;
  return undefined;
}

/** git's `split_cmdline`: words split on whitespace, quotes and backslashes as alias.c reads them. */
export function splitCommandLine(line: string): string[] | string {
  const args: string[] = [];
  let current = "";
  let quoted = "";
  let i = 0;
  while (i < line.length) {
    const c = line[i] as string;
    if (!quoted && /\s/.test(c)) {
      args.push(current);
      current = "";
      while (i + 1 < line.length && /\s/.test(line[i + 1] as string)) i++;
      i++;
    } else if (!quoted && (c === "'" || c === '"')) {
      quoted = c;
      i++;
    } else if (c === quoted) {
      quoted = "";
      i++;
    } else {
      let ch = c;
      if (c === "\\" && quoted !== "'") {
        i++;
        if (i >= line.length) return "cmdline ends with \\";
        ch = line[i] as string;
      }
      current += ch;
      i++;
    }
  }
  if (quoted) return "unclosed quote";
  args.push(current);
  return args;
}

/** gpg-interface.c's `get_default_ssh_signing_key`: the key, or the outcome git ends with. */
async function defaultSshKey(
  command: string,
  cwd: string | undefined,
  options: NodeSignerOptions,
  messages: string[],
): Promise<string | NodeSigningOutcome | undefined> {
  const args = splitCommandLine(command);
  if (typeof args === "string") {
    return {
      messages: [`fatal: malformed build-time gpg.ssh.defaultKeyCommand: ${args}`],
      died: true,
    };
  }
  const result = await run(args, undefined, cwd, options);
  if (result.startError) messages.push(result.startError);
  const stdout = result.stdout.toString("utf8");
  const stderr = result.stderr.toString("utf8");
  if (result.code === 0) {
    const nl = stdout.indexOf("\n");
    const first = nl < 0 ? stdout : stdout.slice(0, nl);
    if (literalSshKey(first) !== undefined) return first;
    messages.push(
      `warning: gpg.ssh.defaultKeyCommand succeeded but returned no keys: ${stderr} ${stdout}`,
    );
  } else messages.push(`warning: gpg.ssh.defaultKeyCommand failed: ${stderr} ${stdout}`);
  return undefined;
}

/** git's `interpolate_path(path, 1)`: `~/` in the home directory. */
function interpolatePath(path: string, options: NodeSignerOptions): string {
  if (path !== "~" && !path.startsWith("~/")) return path;
  const home = (options.env ?? process.env).HOME ?? homedir();
  return path === "~" ? home : join(home, path.slice(2));
}

/** gpg-interface.c's `sign_buffer_ssh`. */
async function signSsh(
  request: NodeSigningRequest,
  options: NodeSignerOptions,
): Promise<NodeSigningOutcome> {
  const messages: string[] = [];
  let key = request.key;
  if (key === undefined && request.defaultKeyCommand !== undefined) {
    const found = await defaultSshKey(request.defaultKeyCommand, request.cwd, options, messages);
    if (typeof found === "object") return found;
    key = found;
  }
  if (!key) {
    messages.push("error: user.signingKey needs to be set for ssh signing");
    return { messages };
  }
  const base = options.tmpdir ?? (options.env ?? process.env).TMPDIR ?? tmpdir();
  const dir = await mkdtemp(join(base, ".git_signing_"));
  try {
    const literal = literalSshKey(key);
    let keyFile: string;
    if (literal !== undefined) {
      keyFile = join(dir, ".git_signing_key_tmp");
      await writeFile(keyFile, literal, { mode: 0o600 });
    } else keyFile = interpolatePath(key, options);
    const bufferFile = join(dir, ".git_signing_buffer_tmp");
    await writeFile(bufferFile, request.payload, { mode: 0o600 });
    const args = [request.program, "-Y", "sign", "-n", "git", "-f", keyFile];
    if (literal !== undefined) args.push("-U");
    args.push(bufferFile);
    const result = await run(args, undefined, request.cwd, options);
    if (result.startError) messages.push(result.startError);
    if (result.code !== 0) {
      const stderr = result.stderr.toString("utf8");
      if (stderr.includes("usage:")) {
        messages.push(
          "error: ssh-keygen -Y sign is needed for ssh signing (available in openssh version 8.2p1+)",
        );
      }
      messages.push(`error: ${stderr}`);
      // the program ran and failed: sign_buffer_ssh's return in git 2.43
      return {
        messages,
        ...(result.startError || result.code < 0 ? {} : { exitCode: result.code }),
      };
    }
    try {
      const signature = await readFile(`${bufferFile}.sig`);
      return { signature: new Uint8Array(signature), ...(messages.length ? { messages } : {}) };
    } catch (error) {
      messages.push(
        `error: failed reading ssh signing data buffer from '${bufferFile}.sig': ${errnoText(error as NodeJS.ErrnoException)}`,
      );
      return { messages };
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** What to check and how (`VerificationRequest` of `@statewalker/vcs-working-tree`). */
export interface NodeVerificationRequest {
  format: "openpgp" | "x509" | "ssh";
  payload: Uint8Array;
  signature: Uint8Array;
  program: string;
  allowedSignersFile?: string;
  revocationFile?: string;
  verifyTime?: number;
  cwd?: string;
}

/** What a check gave (`VerificationOutcome`). */
export interface NodeVerificationOutcome {
  failed: boolean;
  output?: string;
  status?: string;
  messages?: string[];
}

/** The verifier (`Verifier`). */
export type NodeVerifier = ((
  request: NodeVerificationRequest,
) => Promise<NodeVerificationOutcome>) & { compatibility?: "2.43" | "2.56" };

/** How the verifier runs programs: {@link NodeSignerOptions} and the git version followed. */
export interface NodeVerifierOptions extends NodeSignerOptions {
  /** The git version whose rules the commands follow where versions differ (default 2.56) */
  compatibility?: "2.43" | "2.56";
}

/**
 * A verifier that runs the configured program as git's gpg-interface.c does: openpgp as
 * `<program> --keyid-format=long --status-fd=1 --verify <signature file> -` (x509 without
 * the key id format), ssh as `-Y find-principals` against `gpg.ssh.allowedSignersFile`, then
 * `-Y verify` for each principal found (with `-r <revocationFile>` when it exists), or `-Y
 * check-novalidate` when none is. Options as {@link createNodeSigner}'s.
 *
 * @example
 * ```typescript
 * const environment = createNodeGitHostEnvironment({ verifier: createNodeVerifier() });
 * ```
 */
export function createNodeVerifier(options: NodeVerifierOptions = {}): NodeVerifier {
  const verifier: NodeVerifier = async (request) => {
    const base = options.tmpdir ?? (options.env ?? process.env).TMPDIR ?? tmpdir();
    const dir = await mkdtemp(join(base, ".git_vtag_"));
    try {
      const file = join(dir, `.git_vtag_tmp${Math.random().toString(36).slice(2, 8)}`);
      await writeFile(file, request.signature, { mode: 0o600 });
      return request.format === "ssh"
        ? await verifySsh(request, file, options)
        : await verifyGpg(request, file, options);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  };
  if (options.compatibility) verifier.compatibility = options.compatibility;
  return verifier;
}

/** gpg-interface.c's `verify_gpg_signed_buffer`. */
async function verifyGpg(
  request: NodeVerificationRequest,
  file: string,
  options: NodeSignerOptions,
): Promise<NodeVerificationOutcome> {
  const args = [request.program];
  if (request.format === "openpgp") args.push("--keyid-format=long");
  args.push("--status-fd=1", "--verify", file, "-");
  const result = await run(args, request.payload, request.cwd, options);
  const status = result.stdout.toString("utf8");
  const failed =
    result.code !== 0 ||
    (!status.includes("\n[GNUPG:] GOODSIG ") && !status.includes("\n[GNUPG:] EXPKEYSIG "));
  return {
    failed,
    output: result.stderr.toString("utf8"),
    status,
    ...(result.startError ? { messages: [result.startError] } : {}),
  };
}

/** git's `show_date(t, 0, DATE_STRFTIME "%Y%m%d%H%M%S", local)`. */
function localStamp(seconds: number): string {
  const d = new Date(seconds * 1000);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
}

/** git's `strbuf_stripspace(sb, NULL)`. */
export function stripSpace(text: string): string {
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  let out = "";
  let empties = 0;
  for (const raw of lines) {
    const line = raw.replace(/[ \t\n\v\f\r]+$/, "");
    if (line === "") {
      empties++;
      continue;
    }
    if (out !== "" && empties > 0) out += "\n";
    empties = 0;
    out += `${line}\n`;
  }
  return out;
}

/** gpg-interface.c's `verify_ssh_signed_buffer` (the allowed signers file is given). */
async function verifySsh(
  request: NodeVerificationRequest,
  file: string,
  options: NodeSignerOptions,
): Promise<NodeVerificationOutcome> {
  const messages: string[] = [];
  const allowed = request.allowedSignersFile ?? "";
  const verifyTime =
    request.verifyTime !== undefined && request.verifyTime !== 0
      ? `-Overify-time=${localStamp(request.verifyTime)}`
      : "";
  const principals = await run(
    [request.program, "-Y", "find-principals", "-f", allowed, "-s", file, verifyTime],
    undefined,
    request.cwd,
    options,
  );
  if (principals.startError) messages.push(principals.startError);
  const principalsErr = principals.stderr.toString("utf8");
  const principalsOut = principals.stdout.toString("utf8");
  if (principals.code !== 0 && principalsErr.includes("usage:")) {
    messages.push(
      "error: ssh-keygen -Y find-principals/verify is needed for ssh signature verification (available in openssh version 8.2p1+)",
    );
    return { failed: true, messages };
  }
  let failed = true;
  let out = "";
  let err = "";
  if (principals.code !== 0 || principalsOut === "") {
    // no principal in the allowed signers: checked without validation, to show what it is
    const check = await run(
      [request.program, "-Y", "check-novalidate", "-n", "git", "-s", file, verifyTime],
      request.payload,
      request.cwd,
      options,
    );
    if (check.startError) messages.push(check.startError);
    out = check.stdout.toString("utf8");
    err = check.stderr.toString("utf8");
  } else {
    // find-principals succeeded: a list of nothing but empty lines leaves that success
    failed = false;
    for (const rawLine of principalsOut.split("\n")) {
      const principal = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
      if (principal === "") continue;
      const args = [
        request.program,
        "-Y",
        "verify",
        "-n",
        "git",
        "-f",
        allowed,
        "-I",
        principal,
        "-s",
        file,
        verifyTime,
      ];
      if (request.revocationFile !== undefined) {
        const cwd = request.cwd ?? options.defaultCwd ?? process.cwd();
        if (existsSync(resolve(cwd, request.revocationFile))) {
          args.push("-r", request.revocationFile);
        } else {
          messages.push(
            `warning: ssh signing revocation file configured but not found: ${request.revocationFile}`,
          );
        }
      }
      const verified = await run(args, request.payload, request.cwd, options);
      if (verified.startError) messages.push(verified.startError);
      out = verified.stdout.toString("utf8");
      err = verified.stderr.toString("utf8");
      failed = verified.code !== 0 || !out.startsWith("Good");
      if (!failed) break;
    }
  }
  const output = stripSpace(out) + principalsErr + stripSpace(err);
  return { failed, output, status: output, ...(messages.length ? { messages } : {}) };
}
