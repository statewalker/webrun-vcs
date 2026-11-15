import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
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

  it("caches under GITEA_CACHE_DIR, else under the temp directory", () => {
    expect(giteaCacheDir({ GITEA_CACHE_DIR: "/cache/gitea" })).toBe("/cache/gitea");
    expect(giteaCacheDir({})).toBe(join(tmpdir(), "webrun-vcs-gitea-cache"));
    expect(giteaCacheDir({ GITEA_CACHE_DIR: " " })).toBe(join(tmpdir(), "webrun-vcs-gitea-cache"));
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
});
