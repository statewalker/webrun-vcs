/**
 * Pure pieces of a Gitea launch: its `app.ini`, the command lines and the
 * environment. Kept free of side effects so they are unit-tested without a
 * binary.
 */

export interface GiteaAppIniOptions {
  /** Gitea's work directory: database, repositories and LFS objects live under it */
  workDir: string;
  /** The HTTP port (on 127.0.0.1) */
  port: number;
  /** The user Gitea runs as (it checks `RUN_USER` against its own user) */
  runUser: string;
  /** Log level (default `Warn`) */
  logLevel?: string;
}

/**
 * A minimal headless configuration: SQLite, LFS on, offline (no external
 * avatars or CDNs), no SSH, no mailer, registration off, installed
 * (`INSTALL_LOCK`), listening on 127.0.0.1 only.
 */
export function giteaAppIni(o: GiteaAppIniOptions): string {
  const w = o.workDir;
  return [
    "APP_NAME = webrun-vcs Gitea oracle",
    `RUN_USER = ${o.runUser}`,
    "RUN_MODE = prod",
    `WORK_PATH = ${w}`,
    "",
    "[database]",
    "DB_TYPE = sqlite3",
    `PATH = ${w}/data/gitea.db`,
    "",
    "[server]",
    "PROTOCOL = http",
    "HTTP_ADDR = 127.0.0.1",
    `HTTP_PORT = ${o.port}`,
    "DOMAIN = 127.0.0.1",
    `ROOT_URL = http://127.0.0.1:${o.port}/`,
    `APP_DATA_PATH = ${w}/data`,
    "DISABLE_SSH = true",
    "START_SSH_SERVER = false",
    "LFS_START_SERVER = true",
    "OFFLINE_MODE = true",
    "",
    "[lfs]",
    "STORAGE_TYPE = local",
    `PATH = ${w}/data/lfs`,
    "",
    "[repository]",
    `ROOT = ${w}/repos`,
    "DEFAULT_BRANCH = main",
    "",
    "[security]",
    "INSTALL_LOCK = true",
    "",
    "[service]",
    "DISABLE_REGISTRATION = true",
    "REQUIRE_SIGNIN_VIEW = false",
    "",
    "[mailer]",
    "ENABLED = false",
    "",
    "[cron]",
    "ENABLED = false",
    "",
    "[log]",
    "MODE = console",
    `LEVEL = ${o.logLevel ?? "Warn"}`,
    "",
  ].join("\n");
}

export interface GiteaLaunch {
  /** The verified binary */
  bin: string;
  workDir: string;
  /**
   * Run as another (unprivileged) user through `runuser`: Gitea refuses to
   * run as root, so a root test process runs it as `nobody`.
   */
  runAs?: string;
}

/**
 * The command line for one Gitea invocation. As root it goes through
 * `runuser -u <user> -- env HOME=… GITEA_WORK_DIR=… <bin> …`, since runuser
 * resets the environment; otherwise the binary runs directly.
 */
export function giteaCommand(
  launch: GiteaLaunch,
  args: string[],
): { command: string; args: string[] } {
  if (!launch.runAs) return { command: launch.bin, args };
  return {
    command: "runuser",
    args: [
      "-u",
      launch.runAs,
      "--",
      "env",
      `HOME=${launch.workDir}`,
      `GITEA_WORK_DIR=${launch.workDir}`,
      launch.bin,
      ...args,
    ],
  };
}

/** `gitea admin user create` arguments for an admin who need not change the password. */
export function giteaCreateAdminArgs(
  appIni: string,
  user: { name: string; password: string; email: string },
): string[] {
  return [
    "admin",
    "user",
    "create",
    "--admin",
    "--username",
    user.name,
    "--password",
    user.password,
    "--email",
    user.email,
    "--must-change-password=false",
    "-c",
    appIni,
  ];
}

/**
 * The environment Gitea runs in: only its home, work directory and `PATH`,
 * so the caller's `GIT_*`, proxy and Gitea variables do not leak in.
 */
export function giteaEnv(workDir: string, path = "/usr/local/bin:/usr/bin:/bin") {
  return { HOME: workDir, GITEA_WORK_DIR: workDir, PATH: path };
}
