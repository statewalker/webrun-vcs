/**
 * receive-pack's limits, policies and error callbacks over `serveOverDuplex`: `maxInputSize`
 * (git's `receive.maxInputSize`), `advertiseAtomic`, the receive-report hook (git master),
 * `commandError` / `unpackError` (JGit's ReceiveCommandErrorHandler / UnpackErrorHandler),
 * `afterPush`, and the `receive.*` settings read from a config. The native twins are in
 * vcs-commands' `receive-limits-native.test.ts`.
 */

import { describe, expect, it, vi } from "vitest";

import {
  explicitServerSettingsFromConfig,
  humaniseBytes,
  PackInputTooLargeError,
  RECEIVE_PACK_CAPABILITIES,
  receivePackCapabilitiesOf,
  serverSettingsFromConfig,
} from "../src/index.js";
import { encodeFlush, encodePacketLine } from "../src/protocol/pkt-line-codec.js";
import {
  clientWithNewCommits,
  concat,
  fullPackOf,
  runReceivePack,
  serverRepo,
  ZERO,
} from "./helpers/receive-pack-harness.js";

async function setup() {
  const { repo, c2 } = await serverRepo();
  const { client, commits } = await clientWithNewCommits(2);
  const [n0, n1] = commits as [string, string];
  const pack = await fullPackOf(client, [n1], [c2]);
  return { repo, c2, n0, n1, pack };
}

/** A config reader over `entries` (in order). */
function configOf(entries: [string, string | null][]) {
  return {
    getAll: (key: string) =>
      entries.filter(([k]) => k.toLowerCase() === key.toLowerCase()).map(([, v]) => v),
    list: () => entries.map(([key, value]) => ({ key, value })),
    listWithOrigin: () =>
      entries.map(([key, value], i) => ({ key, value, file: "config", line: i + 1 })),
  };
}

describe("receive.maxInputSize", () => {
  it("a pack over the limit is refused as unpack-objects refuses it (few objects)", async () => {
    const { repo, c2, n1, pack } = await setup();
    const run = await runReceivePack(
      repo,
      { commands: [`${c2} ${n1} refs/heads/main`], pack },
      { maxInputSize: 16 },
    );
    expect(run.report).toEqual([
      "unpack unpack-objects abnormal exit",
      "ng refs/heads/main unpacker error",
    ]);
    expect(run.messages).toContain("fatal: pack exceeds maximum allowed size\n");
    expect(await repo.refStore.get("refs/heads/main")).toBe(c2);
    expect(await repo.facade.has(n1)).toBe(false);
  });

  it("index-pack's death names the limit (receive.unpackLimit objects or more)", () => {
    const small = new PackInputTooLargeError(512, 3);
    expect(small.isKept()).toBe(false);
    expect(small.death()).toBe("fatal: pack exceeds maximum allowed size");
    const large = new PackInputTooLargeError(4096, 120);
    expect(large.isKept()).toBe(true);
    expect(large.death()).toBe("fatal: pack exceeds maximum allowed size (4.00 KiB)");
    expect(small.death(1)).toBe("fatal: pack exceeds maximum allowed size (512 bytes)");
  });

  it("a pack within the limit is accepted", async () => {
    const { repo, c2, n1, pack } = await setup();
    const run = await runReceivePack(
      repo,
      { commands: [`${c2} ${n1} refs/heads/main`], pack },
      { maxInputSize: pack.length },
    );
    expect(run.report).toEqual(["unpack ok", "ok refs/heads/main"]);
    expect(await repo.refStore.get("refs/heads/main")).toBe(n1);
  });

  it("strbuf_humanise_bytes", () => {
    expect(humaniseBytes(1)).toBe("1 byte");
    expect(humaniseBytes(512)).toBe("512 bytes");
    expect(humaniseBytes(1024)).toBe("1024 bytes");
    expect(humaniseBytes(4096)).toBe("4.00 KiB");
    expect(humaniseBytes(1536)).toBe("1.50 KiB");
    expect(humaniseBytes(3 * 1024 * 1024)).toBe("3.00 MiB");
    expect(humaniseBytes(2 * 1024 ** 3 + 1)).toBe("2.00 GiB");
  });
});

describe("receive.advertiseAtomic", () => {
  it("false: `atomic` is not advertised, and a client asking for it pushes without it", async () => {
    expect(receivePackCapabilitiesOf(undefined, { advertiseAtomic: false })).not.toContain(
      "atomic",
    );
    expect(receivePackCapabilitiesOf(undefined, {})).toEqual([...RECEIVE_PACK_CAPABILITIES]);
    const { repo, c2, n0, n1, pack } = await setup();
    const run = await runReceivePack(
      repo,
      {
        commands: [`${c2} ${n1} refs/heads/main`, `${ZERO} ${n0} refs/heads/locked`],
        caps: "report-status side-band-64k atomic",
        pack,
      },
      { advertiseAtomic: false, hooks: { update: (ref) => ref !== "refs/heads/locked" } },
    );
    // not atomic: main lands though locked is refused
    expect(run.report).toEqual([
      "unpack ok",
      "ok refs/heads/main",
      "ng refs/heads/locked hook declined",
    ]);
  });
});

describe("the receive-report hook (git master)", () => {
  it("gets the report as pkt-lines; what it returns replaces the report", async () => {
    const { repo, c2, n1, pack } = await setup();
    const seen: string[] = [];
    const run = await runReceivePack(
      repo,
      { commands: [`${c2} ${n1} refs/heads/main`], pack },
      {
        hooks: {
          receiveReport: (report) => {
            seen.push(new TextDecoder().decode(report));
            return concat([
              encodePacketLine("unpack ok\n"),
              encodePacketLine("ng refs/heads/main service-x-is-down\n"),
              encodeFlush(),
            ]);
          },
        },
      },
    );
    expect(seen).toEqual(["000eunpack ok\n0017ok refs/heads/main\n0000"]);
    expect(run.report).toEqual(["unpack ok", "ng refs/heads/main service-x-is-down"]);
    // the ref stays updated
    expect(await repo.refStore.get("refs/heads/main")).toBe(n1);
  });

  it("failing: every command `receive-report hook failed`, and post-receive sees none", async () => {
    const { repo, c2, n1, pack } = await setup();
    const postReceive = vi.fn();
    const run = await runReceivePack(
      repo,
      { commands: [`${c2} ${n1} refs/heads/main`], pack },
      { relayPostReceive: true, hooks: { receiveReport: () => false, postReceive } },
    );
    expect(run.report).toEqual(["unpack ok", "ng refs/heads/main receive-report hook failed"]);
    expect(postReceive).not.toHaveBeenCalled();
    expect(await repo.refStore.get("refs/heads/main")).toBe(n1);
  });

  it("undefined keeps the report", async () => {
    const { repo, c2, n1, pack } = await setup();
    const run = await runReceivePack(
      repo,
      { commands: [`${c2} ${n1} refs/heads/main`], pack },
      { hooks: { receiveReport: () => undefined } },
    );
    expect(run.report).toEqual(["unpack ok", "ok refs/heads/main"]);
  });
});

describe("error callbacks (JGit's ReceiveCommandErrorHandler, UnpackErrorHandler)", () => {
  it("commandError rewords a refused command's reason", async () => {
    const { repo, c2, n0, n1, pack } = await setup();
    const commandError = vi.fn((cmd: { refName: string }, reason: string) =>
      cmd.refName === "refs/heads/locked" ? `locked (${reason})` : undefined,
    );
    const run = await runReceivePack(
      repo,
      { commands: [`${c2} ${n1} refs/heads/main`, `${ZERO} ${n0} refs/heads/locked`], pack },
      { hooks: { update: (ref) => ref !== "refs/heads/locked", commandError } },
    );
    expect(run.report).toEqual([
      "unpack ok",
      "ok refs/heads/main",
      "ng refs/heads/locked locked (hook declined)",
    ]);
    expect(commandError).toHaveBeenCalledTimes(1);
  });

  it("unpackError rewords the unpack status of a pack that could not be stored", async () => {
    const { repo, c2, n1, pack } = await setup();
    const unpackError = vi.fn(() => "pack refused by policy");
    const run = await runReceivePack(
      repo,
      { commands: [`${c2} ${n1} refs/heads/main`], pack },
      { maxInputSize: 16, hooks: { unpackError } },
    );
    expect(run.report).toEqual([
      "unpack pack refused by policy",
      "ng refs/heads/main unpacker error",
    ]);
    expect(unpackError).toHaveBeenCalledWith(
      "unpack-objects abnormal exit",
      expect.anything(),
      expect.anything(),
    );
  });
});

describe("afterPush", () => {
  it("runs after post-receive, before receive-pack ends", async () => {
    const { repo, c2, n1, pack } = await setup();
    const order: string[] = [];
    const run = await runReceivePack(
      repo,
      { commands: [`${c2} ${n1} refs/heads/main`], pack },
      {
        relayPostReceive: true,
        hooks: { postReceive: () => void order.push("post-receive") },
        afterPush: async (ctx) => {
          order.push("after-push");
          await ctx.message("Auto packing\n");
        },
      },
    );
    expect(order).toEqual(["post-receive", "after-push"]);
    expect(run.messages).toContain("Auto packing\n");
  });

  it("runs when no ref moved too (git runs its auto gc for any push with commands)", async () => {
    const { repo, c2, n1, pack } = await setup();
    const afterPush = vi.fn();
    await runReceivePack(
      repo,
      { commands: [`${c2} ${n1} refs/heads/main`], pack },
      { hooks: { update: () => false }, afterPush },
    );
    expect(afterPush).toHaveBeenCalledTimes(1);
  });
});

describe("receive.* settings from a config", () => {
  it("reads maxInputSize with units, keepAlive in seconds, advertiseAtomic", () => {
    const settings = serverSettingsFromConfig(
      configOf([
        ["receive.maxInputSize", "4k"],
        ["receive.keepAlive", "2"],
        ["receive.advertiseAtomic", "false"],
      ]),
    );
    expect(settings.maxInputSize).toBe(4096);
    expect(settings.receiveKeepAliveMs).toBe(2000);
    expect(settings.advertiseAtomic).toBe(false);
    expect(explicitServerSettingsFromConfig(configOf([["receive.keepAlive", "-1"]]))).toEqual({
      receiveKeepAliveMs: 0,
    });
    expect(explicitServerSettingsFromConfig(configOf([]))).toEqual({});
  });

  it("a value git cannot read is receive-pack's death, named as git names it", () => {
    expect(
      explicitServerSettingsFromConfig(configOf([["receive.maxInputSize", "lots"]]))
        .receivePackConfigError,
    ).toBe(
      "fatal: bad numeric config value 'lots' for 'receive.maxinputsize' in file config: invalid unit",
    );
    expect(
      explicitServerSettingsFromConfig(
        configOf([
          ["receive.keepAlive", "99999999999"],
          ["receive.maxInputSize", "x"],
        ]),
      ).receivePackConfigError,
    ).toBe(
      "fatal: bad numeric config value '99999999999' for 'receive.keepalive' in file config: out of range",
    );
  });
});
