/**
 * VCS-based Git HTTP server.
 *
 * Implements the Git smart HTTP protocol using VCS storage,
 * without depending on native git binaries.
 *
 * Handles:
 * - GET /repo.git/info/refs?service=git-upload-pack (fetch/clone refs)
 * - POST /repo.git/git-upload-pack (send pack data to client)
 * - GET /repo.git/info/refs?service=git-receive-pack (push refs)
 * - POST /repo.git/git-receive-pack (receive pack data from client)
 */

import * as http from "node:http";
import {
  type ObjectTypeCode,
  PackWriterStream,
  typeCodeToString,
  typeStringToCode,
} from "@statewalker/vcs-core";
import {
  CAPABILITY_DELETE_REFS,
  CAPABILITY_OFS_DELTA,
  CAPABILITY_REPORT_STATUS,
  CAPABILITY_SIDE_BAND_64K,
  encodeFlush,
  encodePacket,
  packetDataToString,
  pktLineReader,
  SIDEBAND_DATA,
  SIDEBAND_PROGRESS,
} from "@statewalker/vcs-transport";
import { decompressBlockPartial } from "@statewalker/vcs-utils";
import { bytesToHex } from "@statewalker/vcs-utils/hash/utils";

import { type FileHistory, getHead } from "./file-history.js";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export interface VcsHttpServerOptions {
  /** Port to listen on */
  port: number;
  /** Storage getter - returns the FileHistory for a given repository path */
  getStorage: (repoPath: string) => Promise<FileHistory | null>;
}

/**
 * A Git HTTP server that uses VCS storage directly.
 */
export class VcsHttpServer {
  private server: http.Server | null = null;
  private port: number;
  private getStorage: (repoPath: string) => Promise<FileHistory | null>;

  constructor(options: VcsHttpServerOptions) {
    this.port = options.port;
    this.getStorage = options.getStorage;
  }

  /**
   * Start the HTTP server.
   */
  async start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server = http.createServer((req, res) => {
        this.handleRequest(req, res).catch((error) => {
          console.error("Request error:", error);
          if (!res.headersSent) {
            res.writeHead(500);
            res.end("Internal Server Error");
          }
        });
      });

      this.server.on("error", reject);

      this.server.listen(this.port, () => {
        resolve();
      });
    });
  }

  /**
   * Stop the HTTP server.
   */
  async stop(): Promise<void> {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => {
          this.server = null;
          resolve();
        });
      } else {
        resolve();
      }
    });
  }

  /**
   * Handle an incoming HTTP request.
   */
  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url || "/", `http://localhost:${this.port}`);
    const pathname = url.pathname;

    // Parse the repository path from URL
    // URL format: /repo.git/info/refs or /repo.git/git-upload-pack
    const match = pathname.match(/^\/([^/]+\.git)(\/.*)?$/);
    if (!match) {
      res.writeHead(404);
      res.end("Not Found");
      return;
    }

    const repoName = match[1];
    const gitPath = match[2] || "/";

    // Get storage for this repository
    const storage = await this.getStorage(repoName);
    if (!storage) {
      res.writeHead(404);
      res.end("Repository not found");
      return;
    }

    // Handle different git HTTP endpoints
    if (gitPath === "/info/refs") {
      await this.handleInfoRefs(req, res, storage, url);
    } else if (gitPath === "/git-upload-pack") {
      await this.handleUploadPack(req, res, storage);
    } else if (gitPath === "/git-receive-pack") {
      await this.handleReceivePack(req, res, storage);
    } else {
      res.writeHead(404);
      res.end("Not Found");
    }
  }

  /**
   * Handle /info/refs endpoint (ref discovery).
   */
  private async handleInfoRefs(
    _req: http.IncomingMessage,
    res: http.ServerResponse,
    storage: FileHistory,
    url: URL,
  ): Promise<void> {
    const service = url.searchParams.get("service");

    if (!service || !["git-upload-pack", "git-receive-pack"].includes(service)) {
      res.writeHead(403);
      res.end("Forbidden");
      return;
    }

    // Set headers for smart HTTP
    res.setHeader("Content-Type", `application/x-${service}-advertisement`);
    res.setHeader("Cache-Control", "no-cache");

    // Write service announcement
    const serviceAnnouncement = `# service=${service}\n`;
    res.write(this.pktLine(serviceAnnouncement));
    res.write("0000"); // Flush packet

    // Get refs from storage
    const refs = await this.collectRefs(storage);
    const headRef = await storage.refs.get("HEAD");

    // Build capabilities
    const headTarget = headRef && "target" in headRef ? { target: headRef.target } : undefined;
    const capabilities = this.buildCapabilities(service, headTarget);

    // Write refs
    let firstRef = true;
    for (const [refName, objectId] of refs) {
      const line = firstRef
        ? `${objectId} ${refName}\0${capabilities}\n`
        : `${objectId} ${refName}\n`;
      res.write(this.pktLine(line));
      firstRef = false;
    }

    // If no refs (empty repo), send zero-id with capabilities
    if (refs.size === 0) {
      const zeroId = "0".repeat(40);
      res.write(this.pktLine(`${zeroId} capabilities^{}\0${capabilities}\n`));
    }

    res.write("0000"); // Flush packet
    res.end();
  }

  /**
   * Handle git-upload-pack (send objects to client for fetch/clone).
   */
  private async handleUploadPack(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    storage: FileHistory,
  ): Promise<void> {
    // Collect request body
    const body = await this.collectRequestBody(req);

    // Parse the request
    const packets = pktLineReader(this.bufferToAsyncIterable(body));
    const wants: string[] = [];
    const haves: string[] = [];
    let _done = false;
    let useSideband = false;

    for await (const packet of packets) {
      if (packet.type === "flush") {
        continue;
      }
      if (packet.type !== "data" || !packet.data) {
        continue;
      }

      const line = packetDataToString(packet);

      if (line.startsWith("want ")) {
        const parts = line.slice(5).split(" ");
        wants.push(parts[0]);
        if (line.includes(CAPABILITY_SIDE_BAND_64K)) {
          useSideband = true;
        }
      } else if (line.startsWith("have ")) {
        haves.push(line.slice(5).trim());
      } else if (line === "done") {
        _done = true;
        break;
      }
    }

    // Set response headers
    res.setHeader("Content-Type", "application/x-git-upload-pack-result");
    res.setHeader("Cache-Control", "no-cache");

    // Send NAK (we don't implement multi-ack negotiation)
    res.write(this.pktLine("NAK\n"));

    // Build pack file
    const packResult = await this.buildPackForWants(storage, wants, haves);

    if (useSideband) {
      await this.sendSidebandPack(res, packResult.packData);
    } else {
      res.write(packResult.packData);
    }

    res.write("0000"); // Flush
    res.end();
  }

  /**
   * Handle git-receive-pack (receive objects from client for push).
   */
  private async handleReceivePack(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    storage: FileHistory,
  ): Promise<void> {
    const body = await this.collectRequestBody(req);
    const { updates, packData } = this.parseReceivePackRequest(body);

    res.setHeader("Content-Type", "application/x-git-receive-pack-result");
    res.setHeader("Cache-Control", "no-cache");

    const useSideband = updates.some((u) => u.capabilities?.includes(CAPABILITY_SIDE_BAND_64K));

    try {
      if (packData.length > 0) {
        await this.processReceivedPack(storage, packData);
      }

      const results: Array<{ refName: string; ok: boolean; message?: string }> = [];
      for (const update of updates) {
        try {
          await this.applyRefUpdate(storage, update);
          results.push({ refName: update.refName, ok: true });
        } catch (error) {
          results.push({
            refName: update.refName,
            ok: false,
            message: error instanceof Error ? error.message : "unknown error",
          });
        }
      }

      if (useSideband) {
        const statusData = this.buildReportStatus(true, results);
        res.write(this.encodeSidebandPacket(SIDEBAND_DATA, statusData));
        res.write("0000");
      } else {
        res.write(this.pktLine("unpack ok\n"));
        for (const result of results) {
          if (result.ok) {
            res.write(this.pktLine(`ok ${result.refName}\n`));
          } else {
            res.write(this.pktLine(`ng ${result.refName} ${result.message}\n`));
          }
        }
        res.write("0000");
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      if (useSideband) {
        const statusData = this.buildReportStatus(false, [], message);
        res.write(this.encodeSidebandPacket(SIDEBAND_DATA, statusData));
        res.write("0000");
      } else {
        res.write(this.pktLine(`unpack ${message}\n`));
        res.write("0000");
      }
    }

    res.end();
  }

  /**
   * Collect all refs from storage.
   */
  private async collectRefs(storage: FileHistory): Promise<Map<string, string>> {
    const refs = new Map<string, string>();

    const head = await getHead(storage);
    if (head) {
      refs.set("HEAD", head);
    }

    for await (const ref of storage.refs.list()) {
      if ("objectId" in ref && ref.objectId) {
        refs.set(ref.name, ref.objectId);
      }
    }

    return refs;
  }

  /**
   * Build capabilities string for ref advertisement.
   */
  private buildCapabilities(service: string, headRef?: { target?: string } | null): string {
    const caps: string[] = [];

    if (service === "git-upload-pack") {
      caps.push(CAPABILITY_SIDE_BAND_64K);
      caps.push(CAPABILITY_OFS_DELTA);
      caps.push("no-progress");
      caps.push("shallow");
    } else {
      caps.push(CAPABILITY_REPORT_STATUS);
      caps.push(CAPABILITY_SIDE_BAND_64K);
      caps.push(CAPABILITY_DELETE_REFS);
      caps.push(CAPABILITY_OFS_DELTA);
    }

    if (headRef?.target) {
      caps.push(`symref=HEAD:${headRef.target}`);
    }

    caps.push("agent=vcs-http-server/1.0");

    return caps.join(" ");
  }

  /**
   * Build a pack file containing wanted objects.
   */
  private async buildPackForWants(
    storage: FileHistory,
    wants: string[],
    haves: string[],
  ): Promise<{ packData: Uint8Array }> {
    const haveSet = new Set(haves);
    const seen = new Set<string>();
    const objectsToSend: Array<{ id: string; type: number; content: Uint8Array }> = [];

    const collectObject = async (id: string): Promise<void> => {
      if (seen.has(id) || haveSet.has(id)) return;
      seen.add(id);

      const header = await storage.objects.get(id);
      if (!header) throw new Error(`Object not found: ${id}`);
      const chunks: Uint8Array[] = [];
      for await (const chunk of header.content) {
        chunks.push(chunk);
      }
      const content = this.concatBytes(chunks);

      objectsToSend.push({ id, type: typeStringToCode(header.type), content });

      if (header.type === "commit") {
        const commit = await storage.commits.load(id);
        if (commit) {
          await collectObject(commit.tree);
          for (const parent of commit.parents) {
            await collectObject(parent);
          }
        }
      } else if (header.type === "tree") {
        const entries = await storage.trees.load(id);
        if (entries) {
          for await (const entry of entries) {
            await collectObject(entry.id);
          }
        }
      }
    };

    for (const wantId of wants) {
      await collectObject(wantId);
    }

    const packWriter = new PackWriterStream();
    for (const obj of objectsToSend) {
      await packWriter.addObject(obj.id, obj.type, obj.content);
    }
    const result = await packWriter.finalize();

    return { packData: result.packData };
  }

  /**
   * Send pack data via sideband.
   */
  private async sendSidebandPack(res: http.ServerResponse, packData: Uint8Array): Promise<void> {
    const progressMsg = textEncoder.encode("Counting objects...\n");
    res.write(this.encodeSidebandPacket(SIDEBAND_PROGRESS, progressMsg));

    const chunkSize = 65515;
    for (let i = 0; i < packData.length; i += chunkSize) {
      const chunk = packData.subarray(i, Math.min(i + chunkSize, packData.length));
      res.write(this.encodeSidebandPacket(SIDEBAND_DATA, chunk));
    }
  }

  /**
   * Parse receive-pack request.
   */
  private parseReceivePackRequest(body: Uint8Array): {
    updates: Array<{
      oldId: string;
      newId: string;
      refName: string;
      capabilities?: string;
    }>;
    packData: Uint8Array;
  } {
    const updates: Array<{
      oldId: string;
      newId: string;
      refName: string;
      capabilities?: string;
    }> = [];

    let packStart = -1;
    let pos = 0;

    while (pos < body.length) {
      if (
        body[pos] === 0x50 &&
        body[pos + 1] === 0x41 &&
        body[pos + 2] === 0x43 &&
        body[pos + 3] === 0x4b
      ) {
        packStart = pos;
        break;
      }

      const lengthHex = textDecoder.decode(body.subarray(pos, pos + 4));

      if (lengthHex === "0000") {
        pos += 4;
        continue;
      }

      const length = parseInt(lengthHex, 16);
      if (Number.isNaN(length) || length < 4) {
        pos += 4;
        continue;
      }

      const lineData = body.subarray(pos + 4, pos + length);
      const line = textDecoder.decode(lineData).trim();

      const nullIdx = line.indexOf("\0");
      const refPart = nullIdx >= 0 ? line.slice(0, nullIdx) : line;
      const capabilities = nullIdx >= 0 ? line.slice(nullIdx + 1) : undefined;

      const parts = refPart.split(" ");
      if (parts.length >= 3) {
        updates.push({
          oldId: parts[0],
          newId: parts[1],
          refName: parts[2],
          capabilities,
        });
      }

      pos += length;
    }

    const packData = packStart >= 0 ? body.subarray(packStart) : new Uint8Array(0);

    return { updates, packData };
  }

  /**
   * Process a received pack file.
   */
  private async processReceivedPack(storage: FileHistory, packData: Uint8Array): Promise<void> {
    const objectCache = new Map<number, { type: number; content: Uint8Array; id: string }>();
    const objectById = new Map<string, { type: number; content: Uint8Array }>();

    if (packData.length < 12) {
      throw new Error("Pack data too short");
    }
    const signature = (packData[0] << 24) | (packData[1] << 16) | (packData[2] << 8) | packData[3];
    if (signature !== 0x5041434b) {
      throw new Error("Invalid pack signature");
    }
    const objectCount =
      (packData[8] << 24) | (packData[9] << 16) | (packData[10] << 8) | packData[11];

    let offset = 12;
    for (let i = 0; i < objectCount; i++) {
      const entryStart = offset;

      let c = packData[offset++];
      const type = (c >> 4) & 0x07;
      let _size = c & 0x0f;
      let shift = 4;
      while ((c & 0x80) !== 0) {
        c = packData[offset++];
        _size |= (c & 0x7f) << shift;
        shift += 7;
      }

      let baseOffset: number | undefined;
      let baseId: string | undefined;

      if (type === 6) {
        c = packData[offset++];
        baseOffset = c & 0x7f;
        while ((c & 0x80) !== 0) {
          baseOffset++;
          c = packData[offset++];
          baseOffset <<= 7;
          baseOffset += c & 0x7f;
        }
      } else if (type === 7) {
        baseId = bytesToHex(packData.subarray(offset, offset + 20));
        offset += 20;
      }

      const compressed = packData.subarray(offset, packData.length - 20);
      const decompressResult = await decompressBlockPartial(compressed, { raw: false });
      offset += decompressResult.bytesRead;

      let resolved: { type: number; content: Uint8Array; id: string };

      if (type >= 1 && type <= 4) {
        const content = new Uint8Array(decompressResult.data);
        const id = await this.computeObjectId(type, content);
        resolved = { type, content, id };
      } else if (type === 6) {
        const baseObjectOffset = entryStart - (baseOffset || 0);
        const base = objectCache.get(baseObjectOffset);
        if (!base) {
          throw new Error(`OFS_DELTA: base at offset ${baseObjectOffset} not found`);
        }
        const content = this.applyDelta(base.content, decompressResult.data);
        const id = await this.computeObjectId(base.type, content);
        resolved = { type: base.type, content, id };
      } else if (type === 7) {
        const base = objectById.get(baseId || "");
        if (!base) {
          throw new Error(`REF_DELTA: base ${baseId} not found`);
        }
        const content = this.applyDelta(base.content, decompressResult.data);
        const id = await this.computeObjectId(base.type, content);
        resolved = { type: base.type, content, id };
      } else {
        throw new Error(`Unknown object type: ${type}`);
      }

      objectCache.set(entryStart, resolved);
      objectById.set(resolved.id, { type: resolved.type, content: resolved.content });
    }

    for (const [_id, obj] of objectById) {
      const typeString = typeCodeToString(obj.type as ObjectTypeCode);
      await storage.objects.put(typeString, obj.content.length, [obj.content]);
    }
  }

  /**
   * Apply ref update.
   */
  private async applyRefUpdate(
    storage: FileHistory,
    update: { oldId: string; newId: string; refName: string },
  ): Promise<void> {
    const zeroId = "0".repeat(40);

    if (update.newId === zeroId) {
      await storage.refs.remove(update.refName);
    } else {
      await storage.refs.set(update.refName, update.newId);
    }
  }

  /**
   * Build report-status response.
   */
  private buildReportStatus(
    unpackOk: boolean,
    results: Array<{ refName: string; ok: boolean; message?: string }>,
    unpackMessage?: string,
  ): Uint8Array {
    const chunks: Uint8Array[] = [];

    if (unpackOk) {
      chunks.push(encodePacket("unpack ok\n"));
    } else {
      chunks.push(encodePacket(`unpack ${unpackMessage || "failed"}\n`));
    }

    for (const result of results) {
      if (result.ok) {
        chunks.push(encodePacket(`ok ${result.refName}\n`));
      } else {
        chunks.push(encodePacket(`ng ${result.refName} ${result.message || "rejected"}\n`));
      }
    }

    chunks.push(encodeFlush());

    return this.concatBytes(chunks);
  }

  /**
   * Create a pkt-line formatted string.
   */
  private pktLine(data: string): string {
    const length = data.length + 4;
    return length.toString(16).padStart(4, "0") + data;
  }

  /**
   * Encode a sideband packet.
   */
  private encodeSidebandPacket(channel: number, data: Uint8Array): Uint8Array {
    const length = data.length + 5;
    const header = length.toString(16).padStart(4, "0");
    const result = new Uint8Array(length);
    result.set(textEncoder.encode(header), 0);
    result[4] = channel;
    result.set(data, 5);
    return result;
  }

  /**
   * Collect request body.
   */
  private async collectRequestBody(req: http.IncomingMessage): Promise<Uint8Array> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk);
    }
    return new Uint8Array(Buffer.concat(chunks));
  }

  /**
   * Convert buffer to async iterable.
   */
  private async *bufferToAsyncIterable(data: Uint8Array): AsyncIterable<Uint8Array> {
    yield data;
  }

  /**
   * Concatenate byte arrays.
   */
  private concatBytes(arrays: Uint8Array[]): Uint8Array {
    const totalLength = arrays.reduce((sum, arr) => sum + arr.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;
    for (const arr of arrays) {
      result.set(arr, offset);
      offset += arr.length;
    }
    return result;
  }

  /**
   * Compute object ID (SHA-1).
   */
  private async computeObjectId(type: number, content: Uint8Array): Promise<string> {
    const typeStr = this.typeCodeToName(type);
    const header = textEncoder.encode(`${typeStr} ${content.length}\0`);
    const fullData = new Uint8Array(header.length + content.length);
    fullData.set(header, 0);
    fullData.set(content, header.length);

    const hash = await crypto.subtle.digest("SHA-1", fullData);
    return bytesToHex(new Uint8Array(hash));
  }

  /**
   * Convert type code to name.
   */
  private typeCodeToName(type: number): string {
    switch (type) {
      case 1:
        return "commit";
      case 2:
        return "tree";
      case 3:
        return "blob";
      case 4:
        return "tag";
      default:
        throw new Error(`Unknown type code: ${type}`);
    }
  }

  /**
   * Apply delta to base content.
   */
  private applyDelta(base: Uint8Array, delta: Uint8Array): Uint8Array {
    let pos = 0;

    let _baseSize = 0;
    let shift = 0;
    while (pos < delta.length) {
      const b = delta[pos++];
      _baseSize |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
    }

    let resultSize = 0;
    shift = 0;
    while (pos < delta.length) {
      const b = delta[pos++];
      resultSize |= (b & 0x7f) << shift;
      if ((b & 0x80) === 0) break;
      shift += 7;
    }

    const result = new Uint8Array(resultSize);
    let resultPos = 0;

    while (pos < delta.length) {
      const cmd = delta[pos++];

      if (cmd & 0x80) {
        let copyOffset = 0;
        let copySize = 0;

        if (cmd & 0x01) copyOffset = delta[pos++];
        if (cmd & 0x02) copyOffset |= delta[pos++] << 8;
        if (cmd & 0x04) copyOffset |= delta[pos++] << 16;
        if (cmd & 0x08) copyOffset |= delta[pos++] << 24;

        if (cmd & 0x10) copySize = delta[pos++];
        if (cmd & 0x20) copySize |= delta[pos++] << 8;
        if (cmd & 0x40) copySize |= delta[pos++] << 16;

        if (copySize === 0) copySize = 0x10000;

        result.set(base.subarray(copyOffset, copyOffset + copySize), resultPos);
        resultPos += copySize;
      } else if (cmd > 0) {
        result.set(delta.subarray(pos, pos + cmd), resultPos);
        pos += cmd;
        resultPos += cmd;
      } else {
        throw new Error("Invalid delta command: 0");
      }
    }

    return result;
  }
}

/**
 * Create and start a VCS HTTP server.
 */
export async function createVcsHttpServer(options: VcsHttpServerOptions): Promise<VcsHttpServer> {
  const server = new VcsHttpServer(options);
  await server.start();
  return server;
}
