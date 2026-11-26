/**
 * The protocol v2 `object-info` command as a client (git 2.56's fetch-object-info.c): the
 * size and type of objects a server holds, asked without fetching them.
 */

import type { ObjectFormat } from "@statewalker/vcs-utils/hash";
import { encodeDelim, encodeFlush, encodePacketLine, TransportError } from "../protocol/index.js";
import { isObjectIdOf, remoteObjectFormat } from "../protocol/object-format.js";
import type { UploadPackConnection } from "./connection.js";
import { CLIENT_AGENT } from "./fetch-pack.js";

/** What {@link fetchObjectInfo} asks for. */
export interface ObjectInfoRequest {
  /** The objects, full hex ids of the client's format, in the order the answer keeps */
  ids: readonly string[];
  /** Wants sizes (asked only when the server advertises `object-info=... size ...`) */
  size?: boolean;
  /** Wants types (asked only when the server advertises `object-info=... type ...`) */
  type?: boolean;
  /** The client repository's object format (default: the server's): git dies on a mismatch */
  objectFormat?: ObjectFormat;
  /** `session-id=<id>` sent (`transfer.advertiseSID`), when the server advertises its own */
  sessionId?: string;
}

/** One object of an {@link ObjectInfoAnswer}. */
export interface ObjectInfoEntry {
  id: string;
  /** The server does not have it (it answered `<id> `) */
  missing: boolean;
  /** Its size, when sizes were asked and answered */
  size?: number;
  /** Its type, when types were asked and answered */
  type?: "blob" | "tree" | "commit" | "tag";
}

/** The server's answer: which attributes it gave, and each object in the order asked. */
export interface ObjectInfoAnswer {
  /** Sizes were asked and answered (git's `results->sizes`) */
  size: boolean;
  /** Types were asked and answered (git's `results->types`) */
  type: boolean;
  objects: ObjectInfoEntry[];
}

/**
 * A refusal of {@link fetchObjectInfo}, its message git's death without `fatal: `
 * (`object-info requires protocol v2`, `object-info capability is not enabled on the server`,
 * `remote error: <the server's ERR>`, `object-info: expected flush after 2 objects`, ...).
 */
export class ObjectInfoError extends TransportError {
  constructor(message: string) {
    super(message);
    this.name = "ObjectInfoError";
  }
}

const TYPES = new Set(["blob", "tree", "commit", "tag"]);

/**
 * Asks the server for the size and type of `ids` (fetch_object_info): `size` and `type` are
 * sent only when wanted and advertised, the ids always (an existence check at least). The
 * answer is read as git reads it: the attribute lines echoed, then one line per object in
 * order (`<id> ` for one the server lacks), then a flush; anything else is a refusal.
 *
 * @example
 * ```ts
 * const answer = await withRemoteUploadPack(remote, options, (c) =>
 *   fetchObjectInfo(c, { ids: [blobId], size: true, type: true }),
 * );
 * answer.objects[0]; // { id, missing: false, size: 11, type: "blob" }
 * ```
 *
 * @throws ObjectInfoError where git dies (a v0/v1 server, no `object-info`, a malformed answer)
 */
export async function fetchObjectInfo(
  connection: UploadPackConnection,
  request: ObjectInfoRequest,
): Promise<ObjectInfoAnswer> {
  if (connection.version !== 2 || connection.dumb) {
    throw new ObjectInfoError("object-info requires protocol v2");
  }
  const caps = connection.capabilities;
  const advertised = caps.get("object-info");
  if (advertised === undefined) {
    throw new ObjectInfoError("object-info capability is not enabled on the server");
  }
  // server_supports_feature("object-info", <attr>): the capability's value lists it
  const features = advertised.split(" ");
  const askSize = request.size === true && features.includes("size");
  const askType = request.type === true && features.includes("type");

  // write_command_and_capabilities
  const body: Uint8Array[] = [encodePacketLine("command=object-info")];
  if (caps.has("agent")) body.push(encodePacketLine(`agent=${CLIENT_AGENT}`));
  if (request.sessionId !== undefined && caps.has("session-id")) {
    body.push(encodePacketLine(`session-id=${request.sessionId}`));
  }
  const serverFormat = remoteObjectFormat(caps);
  if (!serverFormat) {
    throw new ObjectInfoError(`unknown object format '${caps.get("object-format")}'`);
  }
  const format = request.objectFormat ?? serverFormat;
  if (caps.has("object-format")) {
    if (format.name !== serverFormat.name) {
      throw new ObjectInfoError(
        `mismatched algorithms: client ${format.name}; server ${serverFormat.name}`,
      );
    }
    body.push(encodePacketLine(`object-format=${format.name}`));
  } else if (format.name !== "sha1") {
    throw new ObjectInfoError(`the server does not support algorithm '${format.name}'`);
  }
  body.push(encodeDelim());
  if (askSize) body.push(encodePacketLine("size"));
  if (askType) body.push(encodePacketLine("type"));
  for (const id of request.ids) {
    if (!isObjectIdOf(id, format)) throw new ObjectInfoError(`not a valid object name '${id}'`);
    body.push(encodePacketLine(`oid ${id}`));
  }
  body.push(encodeFlush());

  const pkts = await connection.request(body);
  // packet_reader_read with PACKET_READ_DIE_ON_ERR_PACKET: the next data line, or undefined
  const next = async (): Promise<string | undefined> => {
    const p = await pkts.read();
    if (p?.type !== "data") return undefined;
    const text = p.text;
    if (text.startsWith("ERR ")) throw new ObjectInfoError(`remote error: ${text.slice(4)}`);
    return text;
  };

  const wanted = (askSize ? 1 : 0) + (askType ? 1 : 0);
  let sizeIndex = -1;
  let typeIndex = -1;
  for (let i = 0; i < wanted; i++) {
    const line = await next();
    if (line === undefined) {
      throw new ObjectInfoError(`object-info: expected ${wanted} attributes, got ${i}`);
    }
    if (line === "size") {
      if (!askSize) throw new ObjectInfoError("object-info: unrequested 'size' attribute");
      if (sizeIndex >= 0) throw new ObjectInfoError("object-info: duplicate 'size' attribute");
      sizeIndex = i;
    } else if (line === "type") {
      if (!askType) throw new ObjectInfoError("object-info: unrequested 'type' attribute");
      if (typeIndex >= 0) throw new ObjectInfoError("object-info: duplicate 'type' attribute");
      typeIndex = i;
    } else {
      throw new ObjectInfoError(`object-info: unknown attribute '${line}'`);
    }
  }

  const objects: ObjectInfoEntry[] = [];
  for (const [i, id] of request.ids.entries()) {
    const line = await next();
    if (line === undefined) {
      throw new ObjectInfoError(`object-info: expected ${request.ids.length} objects, got ${i}`);
    }
    const values = line.split(" ");
    if (values[0] !== id) {
      throw new ObjectInfoError(`object-info: expected OID: ${id}, got ${values[0]}`);
    }
    // "<id> ": an object the server does not recognize
    if (values.length >= 2 && values[1] === "") {
      objects.push({ id, missing: true });
      continue;
    }
    if (values.length !== wanted + 1) {
      throw new ObjectInfoError(`object-info: unexpected number of attributes: ${line}`);
    }
    const entry: ObjectInfoEntry = { id, missing: false };
    if (sizeIndex >= 0) {
      const text = values[sizeIndex + 1] as string;
      const size = /^[0-9]+$/.test(text) ? Number(text) : Number.NaN;
      if (!Number.isSafeInteger(size)) {
        throw new ObjectInfoError(`object-info: object ${id} has invalid size ${text}`);
      }
      entry.size = size;
    }
    if (typeIndex >= 0) {
      const text = values[typeIndex + 1] as string;
      if (!TYPES.has(text)) {
        throw new ObjectInfoError(`object-info: object ${id} has invalid type '${text}'`);
      }
      entry.type = text as ObjectInfoEntry["type"];
    }
    objects.push(entry);
  }

  const end = await pkts.read();
  if (end?.type !== "flush") {
    if (end?.type === "data" && end.text.startsWith("ERR ")) {
      throw new ObjectInfoError(`remote error: ${end.text.slice(4)}`);
    }
    throw new ObjectInfoError(`object-info: expected flush after ${request.ids.length} objects`);
  }
  return { size: sizeIndex >= 0, type: typeIndex >= 0, objects };
}
