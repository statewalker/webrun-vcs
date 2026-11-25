/**
 * Reading upload-pack's settings from a served repository's config, as git's
 * upload_pack_config reads them (t5516-fetch-push.sh, t5703-upload-pack-ref-in-want.sh,
 * t5705-session-id-in-capabilities.sh; the native twins are vcs-commands'
 * `upload-pack-config-native.test.ts`).
 */
import { describe, expect, it } from "vitest";

import {
  explicitServerSettingsFromConfig,
  packObjectsHookArgs,
  packObjectsHookInput,
  processSessionId,
  serverV2Capabilities,
  uploadPackRequestPolicyOf,
  validSessionId,
} from "../src/index.js";

/** A config of `entries`, in order. */
function config(entries: Array<[string, unknown]>) {
  return {
    getAll: (key: string) =>
      entries.filter(([k]) => k.toLowerCase() === key.toLowerCase()).map(([, v]) => v),
    list: () => entries.map(([key, value]) => ({ key, value })),
  };
}

describe("upload-pack config", () => {
  it("maps uploadpack.allow*SHA1InWant onto the want policy, in config order", () => {
    expect(uploadPackRequestPolicyOf(config([]))).toBeUndefined();
    expect(uploadPackRequestPolicyOf(config([["uploadpack.allowTipSHA1InWant", "true"]]))).toBe(
      "TIP",
    );
    expect(uploadPackRequestPolicyOf(config([["uploadpack.allowReachableSHA1InWant", null]]))).toBe(
      "REACHABLE_COMMIT",
    );
    expect(
      uploadPackRequestPolicyOf(
        config([
          ["uploadpack.allowTipSHA1InWant", "true"],
          ["uploadpack.allowReachableSHA1InWant", "yes"],
        ]),
      ),
    ).toBe("REACHABLE_COMMIT_TIP");
    expect(uploadPackRequestPolicyOf(config([["uploadpack.allowAnySHA1InWant", "1"]]))).toBe("ANY");
    // allowAnySHA1InWant=false clears the bits set before it
    expect(
      uploadPackRequestPolicyOf(
        config([
          ["uploadpack.allowTipSHA1InWant", "true"],
          ["uploadpack.allowAnySHA1InWant", "false"],
        ]),
      ),
    ).toBe("ADVERTISED");
    // and a later key sets its bit again
    expect(
      uploadPackRequestPolicyOf(
        config([
          ["uploadpack.allowAnySHA1InWant", "true"],
          ["uploadpack.allowReachableSHA1InWant", "false"],
        ]),
      ),
    ).toBe("TIP");
  });

  it("reads allowRefInWant and transfer.advertiseSID, never packObjectsHook", () => {
    const settings = explicitServerSettingsFromConfig(
      config([
        ["uploadpack.allowRefInWant", "true"],
        ["transfer.advertiseSID", null],
        ["uploadpack.packObjectsHook", "./hook"],
      ]),
    );
    expect(settings.allowRefInWant).toBe(true);
    expect(settings.advertiseSID).toBe(true);
    expect("packObjectsHook" in settings).toBe(false);
    expect(explicitServerSettingsFromConfig(config([]))).not.toHaveProperty("allowRefInWant");
  });

  it("advertises ref-in-want and session-id where git's serve.c puts them", () => {
    const caps = serverV2Capabilities(
      undefined,
      true,
      undefined,
      { allowFilter: true },
      {
        allowRefInWant: true,
        sessionId: "sid-1",
      },
    );
    expect(caps.find((c) => c.startsWith("fetch="))).toBe(
      "fetch=shallow wait-for-done filter ref-in-want",
    );
    const sid = caps.indexOf("session-id=sid-1");
    expect(sid).toBe(caps.findIndex((c) => c.startsWith("object-format=")) + 1);
    expect(caps.findIndex((c) => c.startsWith("object-info="))).toBe(sid + 1);
    expect(serverV2Capabilities().some((c) => c.includes("ref-in-want"))).toBe(false);
  });

  it("builds pack-objects' arguments and input as create_pack_file", () => {
    expect(packObjectsHookArgs({ ofsDelta: true, includeTag: true })).toEqual([
      "git",
      "pack-objects",
      "--revs",
      "--stdout",
      "--delta-base-offset",
      "--include-tag",
      "--quiet",
    ]);
    expect(
      packObjectsHookArgs({ shallow: true, thin: true, progress: true, filter: "blob:none" }),
    ).toEqual([
      "git",
      "--shallow-file",
      "",
      "pack-objects",
      "--revs",
      "--stdout",
      "--thin",
      "--shallow",
      "--progress",
      "--filter=blob:none",
    ]);
    expect(packObjectsHookArgs({ ofsDelta: true, includeTag: true }, "2.43")).toEqual([
      "git",
      "pack-objects",
      "--revs",
      "--stdout",
      "--delta-base-offset",
      "--include-tag",
    ]);
    expect(
      packObjectsHookArgs(
        { shallow: true, thin: true, progress: true, filter: "blob:none" },
        "2.43",
      ),
    ).toEqual([
      "git",
      "--shallow-file",
      "",
      "pack-objects",
      "--revs",
      "--thin",
      "--stdout",
      "--shallow",
      "--progress",
      "--filter=blob:none",
    ]);
    const input = packObjectsHookInput({ shallow: ["s"], wants: ["a", "b"], haves: ["c"] });
    expect(new TextDecoder().decode(input)).toBe("--shallow s\na\nb\n--not\nc\n\n");
  });

  it("names the process by one session id without spaces", () => {
    const sid = processSessionId();
    expect(processSessionId()).toBe(sid);
    expect(validSessionId(sid)).toBe(sid);
    expect(validSessionId("a b")).toBeUndefined();
    expect(validSessionId("")).toBeUndefined();
  });
});
