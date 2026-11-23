/**
 * The trailer engine's library API without native git: what later commands call
 * (`amendWithTrailers`, `validateTrailerArgs`, `appendSignoff` with a footer to keep and
 * `dedup`, `trailerLinesOf`), the configuration reader and the command runner contract.
 * The byte-for-byte checks against git are in interpret-trailers-native.test.ts.
 */

import { describe, expect, it } from "vitest";

import {
  amendWithTrailers,
  appendSignoff,
  GitApiError,
  ignoredLogMessageBytes,
  interpretTrailers,
  type TrailerCommand,
  trailerConfigFromEntries,
  trailerLinesOf,
  validateTrailerArgs,
} from "../src/index.js";

const SOB = "Signed-off-by: A <a@b>\n";

describe("trailer engine API", () => {
  it("validateTrailerArgs refuses an empty argument and a missing key", () => {
    expect(validateTrailerArgs(["A: b", "C"])).toBeUndefined();
    expect(validateTrailerArgs(["A: b", ""])).toBe("error: empty --trailer argument");
    expect(validateTrailerArgs(["=x"])).toBe(
      "error: invalid trailer '=x': missing key before separator",
    );
    expect(validateTrailerArgs(["%x"], { separators: "%" })).toMatch(/missing key/);
  });

  it("amendWithTrailers throws on an empty argument and ignores `---`", async () => {
    await expect(amendWithTrailers("s\n", [""])).rejects.toBeInstanceOf(GitApiError);
    const { output } = await amendWithTrailers("s\n\nb\n---\nx\n", ["K: v"]);
    expect(output).toBe("s\n\nb\n---\nx\n\nK: v\n");
  });

  it("interpretTrailers refuses trailers with --only-input / --parse", async () => {
    await expect(interpretTrailers("s\n", { parse: true, trailers: ["A: b"] })).rejects.toThrow(
      /--only-input/,
    );
  });

  it("reads trailer.* in git's order, with its warnings", () => {
    const config = trailerConfigFromEntries([
      { key: "trailer.ack.key", value: "Acked-by" },
      { key: "trailer.where", value: "start" },
      { key: "trailer.ACK.where", value: "bogus" },
      { key: "trailer.ack.key", value: "Ack" },
      { key: "trailer.fix.cmd", value: "echo" },
    ]);
    expect(config.where).toBe("start");
    expect(config.items).toEqual([
      { name: "ack", key: "Ack" },
      { name: "fix", cmd: "echo" },
    ]);
    expect(config.warnings).toEqual([
      "warning: unknown value 'bogus' for key 'trailer.ACK.where'",
      "warning: more than one trailer.ack.key",
    ]);
    expect(() => trailerConfigFromEntries([{ key: "trailer.x.key", value: undefined }])).toThrow(
      /missing value for 'trailer.x.key'/,
    );
  });

  it("runs cmd with the value as $1 and command with $ARG replaced", async () => {
    const seen: TrailerCommand[] = [];
    const runCommand = async (command: TrailerCommand) => {
      seen.push(command);
      if (command.command.startsWith("false")) return { exitCode: 1, stdout: "", stderr: "x\n" };
      return { exitCode: 0, stdout: `  out ${command.args.join(",")}\n\n` };
    };
    const config = {
      items: [
        { name: "fix", cmd: "show" },
        { name: "sign", command: "who $ARG $ARG" },
        { name: "bad", cmd: "false" },
      ],
    };
    const r = await interpretTrailers(
      "s\n",
      { trailers: ["fix: 1", "bad: 2"], runCommand },
      config,
    );
    expect(seen).toEqual([
      { command: "who  $ARG", args: [] },
      { command: "show", args: ["1"] },
      { command: "false", args: ["2"] },
    ]);
    expect(r.output).toBe("s\n\nsign: out\nfix: out 1\nbad: \n");
    expect(r.errors).toBe("x\nerror: running trailer command 'false' failed\n");
    // no runner: nothing runs, and `command` items add nothing
    const none = await interpretTrailers("s\n", { trailers: ["fix: 1"] }, config);
    expect(none.output).toBe("s\n\nfix: 1\n");
  });

  it("appendSignoff keeps the ignored footer after the sign-off and dedups", () => {
    const message = "s\n\nbody\n# comment\n";
    expect(appendSignoff(message, SOB, {}, false, ignoredLogMessageBytes(message))).toBe(
      `s\n\nbody\n\n${SOB}# comment\n`,
    );
    const signed = `s\n\n${SOB}Acked-by: x\n`;
    expect(appendSignoff(signed, SOB)).toBe(`${signed}${SOB}`);
    expect(appendSignoff(signed, SOB, {}, true)).toBe(signed);
    expect(appendSignoff(`s\n\n${SOB}`, SOB)).toBe(`s\n\n${SOB}`);
  });

  it("trailerLinesOf lists the block's lines, values unfolded", () => {
    const lines = trailerLinesOf("s\n\nSigned-off-by: x\nA: 1\n  more\nnot one\n# c\n");
    expect(lines.map((l) => [l.key, l.value, l.isTrailer])).toEqual([
      ["Signed-off-by", "x", true],
      ["A", "1 more", true],
      ["not one", "", false],
    ]);
  });
});
