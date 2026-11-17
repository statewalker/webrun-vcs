import { describe, expect, it } from "vitest";
import { OrderedMap } from "../../src/collections/index.js";

describe("OrderedMap", () => {
  it("keeps a Map's order: set keeps a key's place, touch moves it last", () => {
    const m = new OrderedMap<string, number>();
    m.set("a", 1).set("b", 2).set("c", 3);
    m.set("a", 10);
    expect([...m.keys()]).toEqual(["a", "b", "c"]);
    expect(m.touch("a")).toBe(10);
    expect([...m.keys()]).toEqual(["b", "c", "a"]);
    expect(m.oldestKey()).toBe("b");
    expect(m.oldestValue()).toBe(2);
    expect(m.deleteOldest()).toBe("b");
    expect(m.delete("c")).toBe(true);
    expect(m.delete("c")).toBe(false);
    expect([...m.values()]).toEqual([10]);
    expect(m.size).toBe(1);
    m.clear();
    expect(m.oldestKey()).toBeUndefined();
    expect(m.deleteOldest()).toBeUndefined();
    expect(m.touch("a")).toBeUndefined();
  });

  it("evicts as a Map evicting its first key would, over random operations", () => {
    let seed = 1;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    const ours = new OrderedMap<number, number>();
    const map = new Map<number, number>();
    for (let i = 0; i < 20000; i++) {
      const k = rnd(500);
      const op = rnd(4);
      if (op === 0) {
        ours.set(k, i);
        map.set(k, i);
      } else if (op === 1) {
        const v = map.get(k);
        if (v !== undefined) {
          map.delete(k);
          map.set(k, v);
        }
        expect(ours.touch(k)).toBe(v);
      } else if (op === 2) {
        expect(ours.delete(k)).toBe(map.delete(k));
      } else {
        while (map.size > 100) {
          const first = map.keys().next().value as number;
          map.delete(first);
          expect(ours.deleteOldest()).toBe(first);
        }
      }
      expect(ours.size).toBe(map.size);
      expect(ours.get(k)).toBe(map.get(k));
    }
    expect([...ours.keys()]).toEqual([...map.keys()]);
  });
  it("keeps walking when the current entry is deleted, as a Map does", () => {
    const m = new OrderedMap<string, number>();
    m.set("a", 1).set("b", 2).set("c", 3).set("d", 4);
    const seen: string[] = [];
    for (const k of m.keys()) {
      seen.push(k);
      m.delete(k);
    }
    expect(seen).toEqual(["a", "b", "c", "d"]);
    expect(m.size).toBe(0);
    m.set("x", 1).set("y", 2).set("z", 3);
    const values: number[] = [];
    for (const v of m.values()) {
      values.push(v);
      if (v === 1) m.deleteOldest();
    }
    expect(values).toEqual([1, 2, 3]);
  });

  it("walks as a Map's iterator does while entries change under it", () => {
    let seed = 7;
    const rnd = (n: number) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed % n;
    };
    for (let round = 0; round < 300; round++) {
      const ours = new OrderedMap<number, number>();
      const map = new Map<number, number>();
      for (let i = 0; i < 12; i++) {
        const k = rnd(16);
        ours.set(k, i);
        map.set(k, i);
      }
      const a = ours.keys();
      const b = map.keys();
      const walked: number[] = [];
      for (let step = 0; step < 40; step++) {
        const x = b.next();
        const y = a.next();
        expect(y.done).toBe(x.done);
        if (x.done) break;
        expect(y.value).toBe(x.value);
        walked.push(x.value as number);
        const k = rnd(3) === 0 ? (x.value as number) : rnd(16);
        const op = rnd(6);
        if (op === 0) {
          expect(ours.delete(k)).toBe(map.delete(k));
        } else if (op === 1) {
          ours.set(k, step);
          map.set(k, step);
        } else if (op === 2) {
          const v = map.get(k);
          if (v !== undefined) {
            map.delete(k);
            map.set(k, v);
          }
          ours.touch(k);
        } else if (op === 3 && map.size > 0) {
          const first = map.keys().next().value as number;
          map.delete(first);
          expect(ours.deleteOldest()).toBe(first);
        } else if (op === 4 && rnd(8) === 0) {
          ours.clear();
          map.clear();
        }
      }
      expect([...ours.keys()]).toEqual([...map.keys()]);
    }
  });
});
