/**
 * `PktStream.demultiplex`: protocol v2's `sideband-all` read as git's `packet_reader` with
 * `use_sideband` (pkt-line.c, sideband.c's demultiplex_sideband). The native twins are
 * vcs-commands' `sideband-all-native.test.ts`.
 */
import { describe, expect, it } from "vitest";

import { PktStream } from "../../src/fetch-client/index.js";
import { PacketLineError, ServerError } from "../../src/protocol/index.js";

const encoder = new TextEncoder();

/** A packet of `band` (or none) and `text`. */
function pkt(text: string, band?: number): Uint8Array {
  const payload = encoder.encode(text);
  const body = band === undefined ? payload : new Uint8Array([band, ...payload]);
  const head = encoder.encode((body.length + 4).toString(16).padStart(4, "0"));
  return new Uint8Array([...head, ...body]);
}

const flush = encoder.encode("0000");
const delim = encoder.encode("0001");

async function* source(...chunks: Uint8Array[]): AsyncGenerator<Uint8Array> {
  for (const c of chunks) yield c;
}

describe("PktStream sideband-all", () => {
  it("reads band 1 as the packet, band 2 as progress, and leaves flushes and delimiters", async () => {
    const progress: string[] = [];
    const pkts = new PktStream(
      source(
        pkt("acknowledgments\n", 1),
        pkt("counting\n", 2),
        pkt("ready\n", 1),
        delim,
        pkt("packfile\n", 1),
        pkt("PACK", 1),
        flush,
      ),
    );
    pkts.demultiplex({ onProgress: (m) => progress.push(m) });
    expect(await pkts.readLine()).toBe("acknowledgments");
    expect(await pkts.readLine()).toBe("ready");
    expect((await pkts.read())?.type).toBe("delim");
    expect(await pkts.readLine()).toBe("packfile");
    // the packfile section's packets keep their band byte
    pkts.demultiplex(false);
    const raw = await pkts.read();
    expect(raw?.type === "data" && raw.data[0]).toBe(1);
    expect(progress).toEqual(["counting\n"]);
  });

  it("throws band 3 as the server's error, and a packet without a known band", async () => {
    const error = new PktStream(source(pkt("unknown ref refs/heads/x", 3)));
    error.demultiplex({});
    await expect(error.readLine()).rejects.toThrow(ServerError);
    const bad = new PktStream(source(pkt("x", 5)));
    bad.demultiplex({});
    await expect(bad.read()).rejects.toThrow(PacketLineError);
    const empty = new PktStream(source(encoder.encode("0004")));
    empty.demultiplex({});
    await expect(empty.read()).rejects.toThrow("missing sideband designator");
  });
});
