/**
 * The `remote-object-info` twins (t1017) with git master (`$GIT3`) as the native client: the
 * git on PATH in CI may predate 2.56, which added the command. Skipped without `$GIT3`.
 */
import { describe, it } from "vitest";
import { defineRemoteObjectInfoTwins } from "./remote-object-info-native-support.js";

const git3 = process.env.GIT3;
if (git3) defineRemoteObjectInfoTwins(git3);
else
  describe.skip("remote-object-info twins against git master ($GIT3 unset)", () =>
    it("skipped", () => {}));
