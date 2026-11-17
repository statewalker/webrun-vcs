import { describe, expect, it } from "vitest";

import { gitBool, readConversionSettings } from "../../src/convert/index.js";

describe("readConversionSettings: booleans as git_config_bool reads them", () => {
  it("an empty value is false, a key with no `=` (the boolean true) is true", () => {
    expect(gitBool("")).toBe(false);
    expect(gitBool(true)).toBe(true);
    const empty = readConversionSettings({
      "core.ignorecase": "",
      "core.autocrlf": "",
      "core.safecrlf": "",
      "filter.x.required": "",
    });
    expect(empty.ignoreCase).toBe(false);
    expect(empty.autocrlf).toBe("false");
    expect(empty.safecrlf).toBe("off");
    expect(empty.drivers.get("x")?.required).toBe(false);
    const bare = readConversionSettings({
      "core.ignorecase": true,
      "core.autocrlf": true,
      "core.safecrlf": true,
      "filter.x.required": true,
    });
    expect(bare.ignoreCase).toBe(true);
    expect(bare.autocrlf).toBe("true");
    expect(bare.safecrlf).toBe("die");
    expect(bare.drivers.get("x")?.required).toBe(true);
  });
});
