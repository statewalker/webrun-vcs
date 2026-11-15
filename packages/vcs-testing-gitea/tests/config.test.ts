import {
  chmodSync,
  chownSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  assertPrivateDir,
  copyVerified,
  ensureGiteaBinary,
  fileSha256,
  GITEA_VERSION,
  giteaAppIni,
  giteaCacheDir,
  giteaCommand,
  giteaCreateAdminArgs,
  giteaEnv,
  giteaOracleEnabled,
  giteaPlatform,
  giteaRelease,
  redactCredentials,
} from "../src/index.js";

/** No binary needed: the configuration, command lines and checks that a launch is made of. */

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "gitea-config-"));
  dirs.push(d);
  return d;
};

describe("release", () => {
  it("names Gitea's platforms and pins a hash for each", () => {
    expect(giteaPlatform("linux", "x64")).toBe("linux-amd64");
    expect(giteaPlatform("linux", "arm64")).toBe("linux-arm64");
    expect(giteaPlatform("darwin", "arm64")).toBe("darwin-10.12-arm64");
    expect(giteaPlatform("win32", "x64")).toBeUndefined();
    expect(giteaPlatform("linux", "ia32")).toBeUndefined();
    const r = giteaRelease("linux", "x64");
    expect(r).toEqual({
      version: GITEA_VERSION,
      platform: "linux-amd64",
      fileName: `gitea-${GITEA_VERSION}-linux-amd64`,
      url: `https://dl.gitea.com/gitea/${GITEA_VERSION}/gitea-${GITEA_VERSION}-linux-amd64`,
      sha256: "fd77f1a0273c85a0950207c1cfa6753a9fa57604e4ab1382484b191cc919ce15",
    });
    expect(giteaRelease("darwin", "x64").sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(() => giteaRelease("win32", "x64")).toThrow(/no Gitea .* pinned for win32-x64/);
  });
});

describe("env", () => {
  it("runs only with GITEA=1 (or true)", () => {
    expect(giteaOracleEnabled({})).toBe(false);
    expect(giteaOracleEnabled({ GITEA: "0" })).toBe(false);
    expect(giteaOracleEnabled({ GITEA: "" })).toBe(false);
    expect(giteaOracleEnabled({ GITEA: "1" })).toBe(true);
    expect(giteaOracleEnabled({ GITEA: "true" })).toBe(true);
  });

  it("caches under GITEA_CACHE_DIR, else in a per-user cache directory (never the shared temp)", () => {
    expect(giteaCacheDir({ GITEA_CACHE_DIR: "/cache/gitea" }, "/home/u")).toBe("/cache/gitea");
    expect(giteaCacheDir({}, "/home/u")).toBe("/home/u/.cache/webrun-vcs-gitea");
    expect(giteaCacheDir({ GITEA_CACHE_DIR: " " }, "/home/u")).toBe(
      "/home/u/.cache/webrun-vcs-gitea",
    );
    expect(giteaCacheDir({ XDG_CACHE_HOME: "/x" }, "/home/u")).toBe("/x/webrun-vcs-gitea");
    expect(giteaCacheDir({}).startsWith(tmpdir())).toBe(false);
  });
});

describe("app.ini", () => {
  const ini = giteaAppIni({ workDir: "/w", port: 4321, runUser: "nobody" });
  const section = (name: string) => {
    const start = ini.indexOf(`[${name}]\n`);
    expect(start, name).toBeGreaterThanOrEqual(0);
    const end = ini.indexOf("\n[", start + 1);
    return ini.slice(start, end < 0 ? undefined : end);
  };

  it("is headless: sqlite, offline, LFS on, local only, no SSH, installed", () => {
    expect(ini).toContain("RUN_USER = nobody\n");
    expect(ini).toContain("WORK_PATH = /w\n");
    expect(section("database")).toContain("DB_TYPE = sqlite3");
    expect(section("database")).toContain("PATH = /w/data/gitea.db");
    const server = section("server");
    expect(server).toContain("HTTP_ADDR = 127.0.0.1");
    expect(server).toContain("HTTP_PORT = 4321");
    expect(server).toContain("ROOT_URL = http://127.0.0.1:4321/");
    expect(server).toContain("LFS_START_SERVER = true");
    expect(server).toContain("OFFLINE_MODE = true");
    expect(server).toContain("DISABLE_SSH = true");
    expect(section("lfs")).toContain("PATH = /w/data/lfs");
    expect(section("repository")).toContain("ROOT = /w/repos");
    expect(section("security")).toContain("INSTALL_LOCK = true");
    expect(section("service")).toContain("DISABLE_REGISTRATION = true");
    expect(section("log")).toContain("LEVEL = Warn");
  });

  it("takes a log level", () => {
    expect(giteaAppIni({ workDir: "/w", port: 1, runUser: "u", logLevel: "Debug" })).toContain(
      "LEVEL = Debug\n",
    );
  });
});

describe("command lines", () => {
  it("runs the binary directly, or through runuser as another user (as root)", () => {
    expect(giteaCommand({ bin: "/c/gitea", workDir: "/w" }, ["web", "-c", "/w/app.ini"])).toEqual({
      command: "/c/gitea",
      args: ["web", "-c", "/w/app.ini"],
    });
    expect(
      giteaCommand({ bin: "/c/gitea", workDir: "/w", runAs: "nobody" }, ["migrate", "-c", "x"]),
    ).toEqual({
      command: "runuser",
      args: [
        "-u",
        "nobody",
        "--",
        "env",
        "HOME=/w",
        "GITEA_WORK_DIR=/w",
        "/c/gitea",
        "migrate",
        "-c",
        "x",
      ],
    });
  });

  it("creates an admin who need not change the password", () => {
    const args = giteaCreateAdminArgs("/w/app.ini", {
      name: "u",
      password: "p",
      email: "u@example.com",
    });
    expect(args.slice(0, 4)).toEqual(["admin", "user", "create", "--admin"]);
    expect(args).toContain("--must-change-password=false");
    expect(args.slice(-2)).toEqual(["-c", "/w/app.ini"]);
    expect(args[args.indexOf("--username") + 1]).toBe("u");
    expect(args[args.indexOf("--password") + 1]).toBe("p");
  });

  it("gives Gitea a clean environment", () => {
    expect(giteaEnv("/w", "/bin")).toEqual({ HOME: "/w", GITEA_WORK_DIR: "/w", PATH: "/bin" });
  });
});

describe("binary checks", () => {
  const fake = (bytes: string) => {
    const d = tmp();
    const f = join(d, "gitea");
    writeFileSync(f, bytes);
    return f;
  };
  const release = {
    version: "0.0.0",
    platform: "test",
    fileName: "gitea-0.0.0-test",
    url: "http://127.0.0.1:1/never",
    sha256: "",
  };

  it("hashes a file", async () => {
    expect(await fileSha256(fake("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("takes a local copy whose hash matches, then reuses the cached one", async () => {
    const source = fake("abc");
    const cacheDir = join(tmp(), "cache");
    const r = { ...release, sha256: await fileSha256(source) };
    const bin = await ensureGiteaBinary({ release: r, cacheDir, source });
    expect(bin).toBe(join(cacheDir, r.fileName));
    rmSync(source);
    expect(await ensureGiteaBinary({ release: r, cacheDir, source })).toBe(bin);
  });

  it("refuses a copy whose hash does not match, and keeps nothing", async () => {
    const cacheDir = join(tmp(), "cache");
    await expect(
      ensureGiteaBinary({
        release: { ...release, sha256: "0".repeat(64) },
        cacheDir,
        source: fake("x"),
      }),
    ).rejects.toThrow(/cannot obtain Gitea 0\.0\.0: .*SHA-256 [0-9a-f]{64}, expected 0{64}/);
    expect(readdirSync(cacheDir)).toEqual([]);
  });

  it("makes a new cache directory private (0700)", async () => {
    const source = fake("abc");
    const cacheDir = join(tmp(), "new", "cache");
    await ensureGiteaBinary({
      release: { ...release, sha256: await fileSha256(source) },
      cacheDir,
      source,
    });
    expect(statSync(cacheDir).mode & 0o777).toBe(0o700);
  });

  it("refuses a cache directory others can write, a symlink, or one of another user", async () => {
    const source = fake("abc");
    const r = { ...release, sha256: await fileSha256(source) };
    const shared = join(tmp(), "shared");
    mkdirSync(shared);
    chmodSync(shared, 0o777);
    await expect(ensureGiteaBinary({ release: r, cacheDir: shared, source })).rejects.toThrow(
      /writable by group or others \(mode 777\)/,
    );
    await expect(assertPrivateDir(shared)).rejects.toThrow(/writable by group or others/);
    const real = join(tmp(), "real");
    mkdirSync(real, { mode: 0o700 });
    const link = join(tmp(), "link");
    symlinkSync(real, link);
    await expect(ensureGiteaBinary({ release: r, cacheDir: link, source })).rejects.toThrow(
      /not a directory/,
    );
    await expect(assertPrivateDir(real)).resolves.toBeUndefined();
    if (process.getuid?.() === 0) {
      const foreign = join(tmp(), "foreign");
      mkdirSync(foreign, { mode: 0o700 });
      chownSync(foreign, 65534, 65534);
      await expect(ensureGiteaBinary({ release: r, cacheDir: foreign, source })).rejects.toThrow(
        /belongs to uid 65534/,
      );
    }
  });

  it("replaces a cached binary others can write", async () => {
    const source = fake("abc");
    const r = { ...release, sha256: await fileSha256(source) };
    const cacheDir = join(tmp(), "cache");
    const bin = await ensureGiteaBinary({ release: r, cacheDir, source });
    chmodSync(bin, 0o777);
    expect(await ensureGiteaBinary({ release: r, cacheDir, source })).toBe(bin);
    expect(statSync(bin).mode & 0o777).toBe(0o700);
  });

  it("copies the binary and hashes the copy: a copy that does not match is removed", async () => {
    const source = fake("abc");
    const dir = tmp();
    await copyVerified(source, join(dir, "ok"), await fileSha256(source));
    expect(statSync(join(dir, "ok")).mode & 0o777).toBe(0o700);
    await expect(copyVerified(source, join(dir, "bad"), "0".repeat(64))).rejects.toThrow(
      /SHA-256 [0-9a-f]{64}, expected 0{64}/,
    );
    expect(readdirSync(dir)).toEqual(["ok"]);
  });
});

describe("redaction", () => {
  it("drops credentials from URLs in messages", () => {
    expect(
      redactCredentials(
        "fatal: unable to access 'http://oracle:s3cr3t@127.0.0.1:3000/oracle/r.git/' and https://a:b@x/y",
      ),
    ).toBe("fatal: unable to access 'http://***@127.0.0.1:3000/oracle/r.git/' and https://***@x/y");
    expect(redactCredentials("http://127.0.0.1:3000/oracle/r.git")).toBe(
      "http://127.0.0.1:3000/oracle/r.git",
    );
  });
});
