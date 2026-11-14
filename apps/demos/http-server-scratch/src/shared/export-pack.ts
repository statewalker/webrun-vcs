/**
 * The pack a push sends: the objects reachable from `wants` and not from `exclude` (the remote's
 * refs), listed by `listObjects` and streamed by `writePack` with the delta search on; OFS deltas
 * only when `options.ofsDelta` (the remote advertised `ofs-delta`).
 */
import { type GitObjects, type ListedObject, listObjects, writePack } from "@statewalker/vcs-core";

export async function* exportPack(
  objects: GitObjects,
  wants: Iterable<string>,
  exclude: Iterable<string>,
  options: { ofsDelta?: boolean } = {},
): AsyncGenerator<Uint8Array> {
  const listed: ListedObject[] = [];
  for await (const o of listObjects(objects, { wants, haves: exclude })) listed.push(o);
  yield* writePack(objects, listed, { deltaSearch: true, ofsDelta: options.ofsDelta });
}
