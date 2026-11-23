/**
 * The attribute source of the commands (`$GIT_ATTR_SOURCE`, `git --attr-source`, `attr.tree`):
 * its tree-ish resolved with git's revision syntax, as `repo_get_oid_treeish` resolves it,
 * then peeled to a tree as `get_tree_entry` peels it.
 */

import type { Blobs, Trees } from "@statewalker/vcs-core";
import {
  AttributesResolver,
  type AttributesSourceResolver,
  type AttributesSourceTree,
  attributesSourceSetting,
  expandUserPath,
  readTreeAttributesFile,
  resolveAttributesSource,
  type WorkingCopy,
  xdgConfigPath,
} from "@statewalker/vcs-working-tree";
import { hostEnvironmentOf } from "./git-ident.js";
import { configBool, configValue } from "./merge-config.js";
import type { RevisionResolver } from "./revision-resolver.js";

const FULL_ID = /^(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/;

/**
 * Resolves attribute sources through `resolver` (a fresh one per lookup). A full object id
 * stands for itself, stored or not (git's `get_oid` does not look it up): a missing object
 * then gives no in-tree attributes, as an object that is no tree does.
 */
export function attributesSourceResolver(
  resolver: () => RevisionResolver,
): AttributesSourceResolver {
  return async (name) => {
    const revisions = resolver();
    const id = FULL_ID.test(name)
      ? name.toLowerCase()
      : await revisions.resolve(name, { hint: "treeish" });
    if (id === undefined) return undefined;
    const tree = await revisions.peelToType(id, "tree").catch(() => undefined);
    return { tree };
  };
}

/**
 * The attributes of a bare repository (or one whose worktree is not read): builtin, system,
 * global and `info/attributes`, and the in-tree files of an attribute source
 * (`$GIT_ATTR_SOURCE`, `attr.tree`) only, as git 2.5x reads them without a worktree.
 */
export function bareAttributesResolver(o: {
  workingCopy: WorkingCopy;
  trees: Trees;
  blobs: Blobs;
  revisions: () => RevisionResolver;
}): AttributesResolver {
  const { workingCopy } = o;
  const environment = hostEnvironmentOf(workingCopy);
  const gitDir = (workingCopy.config as { hostGitDir?: string } | undefined)?.hostGitDir;
  const read = (file: string | undefined) =>
    file && environment ? environment.readFile(file).catch(() => undefined) : undefined;
  let source: Promise<AttributesSourceTree | undefined> | undefined;
  return new AttributesResolver(
    {
      system: async () => read(environment?.systemAttributes),
      global: async () => {
        const configured = configValue(workingCopy, "core.attributesFile");
        return read(
          configured
            ? expandUserPath(configured, environment)
            : xdgConfigPath(environment, "attributes"),
        );
      },
      info: async () => read(gitDir ? `${gitDir.replace(/\/+$/, "")}/info/attributes` : undefined),
      // only from an attribute source (`$GIT_ATTR_SOURCE`, `attr.tree`)
      inTree: async (dir) => {
        source ??= (async () => {
          const setting = attributesSourceSetting(
            environment?.attrSource,
            configValue(workingCopy, "attr.tree"),
          );
          if (!setting) return undefined;
          return resolveAttributesSource(setting, attributesSourceResolver(o.revisions));
        })();
        const found = await source;
        if (!found) return undefined;
        const file = await readTreeAttributesFile(
          o.trees,
          o.blobs,
          found.tree,
          dir ? `${dir}/.gitattributes` : ".gitattributes",
        );
        return file ? { key: `blob:${file.id}`, content: file.content } : undefined;
      },
    },
    { ignoreCase: configBool(workingCopy, "core.ignoreCase", false) },
  );
}
