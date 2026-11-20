/**
 * The own-namespace rule of a `git:write-own` caller, shared by the smart-HTTP handler and the
 * native (duplex) handler: receive-pack hooks that refuse every command outside the prefix.
 */

import type {
  HookResult,
  HookVerdict,
  ReceiveCommand,
  ReceivePackHookContext,
  ReceivePackHooks,
} from "@statewalker/vcs-transport";

/** A hook verdict as the refs it refuses (`"all"`: the whole push) and why. */
function refusedBy(
  verdict: HookVerdict,
): { refs: Set<string> | "all"; message?: string } | undefined {
  if (verdict === undefined || verdict === true) return undefined;
  if (verdict === false) return { refs: "all" };
  if (typeof verdict === "string") return { refs: "all", message: verdict };
  const result = verdict as HookResult;
  if (result.ok) return undefined;
  return {
    refs: result.rejectedRefs ? new Set(result.rejectedRefs) : "all",
    message: result.message,
  };
}

/**
 * Hooks that keep a `git:write-own` caller inside `prefix`, checked before the pack is read
 * (`ng <ref> not allowed …`; a push refused for every ref stores nothing) and again per ref,
 * then the application's own `hooks`.
 */
export function ownNamespaceHooks(
  prefix: string,
  hooks: ReceivePackHooks | undefined,
): ReceivePackHooks {
  const message = `not allowed: this peer writes ${prefix}* only`;
  const outside = (ref: string) => !ref.startsWith(prefix);
  return {
    ...hooks,
    async authorize(commands: readonly ReceiveCommand[], ctx: ReceivePackHookContext) {
      const refused = commands.filter((c) => outside(c.refName)).map((c) => c.refName);
      const theirs = hooks?.authorize ? refusedBy(await hooks.authorize(commands, ctx)) : undefined;
      // the application refused the whole push: its answer (a 403 over smart HTTP)
      if (theirs?.refs === "all") return { ok: false, message: theirs.message };
      const all = new Set([...refused, ...(theirs?.refs ?? [])]);
      if (all.size === 0) return true;
      return {
        ok: false,
        rejectedRefs: [...all],
        message: refused.length > 0 ? message : theirs?.message,
      };
    },
    async update(refName, oldOid, newOid, ctx) {
      if (outside(refName)) return message;
      return hooks?.update?.(refName, oldOid, newOid, ctx);
    },
  };
}
