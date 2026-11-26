/**
 * The translation API of a repository with `extensions.compatObjectFormat`: ids mapped
 * through its loose object map (git's `repo_oid_to_algop`), objects read under an id of the
 * other format converted into that format (`odb_read_object_info_extended` for such an id).
 */

import type { CompatObjects, GitObjects } from "@statewalker/vcs-core";

import type { LooseObjectMap } from "./loose-object-map.js";
import { convertObjectContent } from "./object-convert.js";

/** The translation API over `map`, reading objects from `objects`. */
export function createCompatObjects(map: LooseObjectMap, objects: GitObjects): CompatObjects {
  return {
    storage: map.storage,
    compat: map.compat,
    toCompat: (id) => map.toCompat(id),
    toStorage: (compatId) => map.toStorage(compatId),
    compatIdsWithPrefix: (prefix) => map.compatIdsWithPrefix(prefix),
    convertToCompat: (type, content) =>
      convertObjectContent(type, content, map.storage, map.compat, (i) => map.toCompat(i)),
    async readAsCompat(compatId) {
      const id = await map.toStorage(compatId);
      if (id === undefined) return undefined;
      const obj = await objects.get(id);
      if (!obj) return undefined;
      const chunks: Uint8Array[] = [];
      let n = 0;
      for await (const c of obj.content) {
        chunks.push(c.slice());
        n += c.length;
      }
      const content = new Uint8Array(n);
      let at = 0;
      for (const c of chunks) {
        content.set(c, at);
        at += c.length;
      }
      return {
        type: obj.type,
        content: await convertObjectContent(obj.type, content, map.storage, map.compat, (i) =>
          map.toCompat(i),
        ),
      };
    },
  };
}
