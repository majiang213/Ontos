// 轮询纯函数核心（pollOnce）的 harness：注入假 fetch，直测 304 / rev 判定 / busy 豁免 / formBlocked / 失败一次。

import { describe, expect, it } from "vitest";
import { pollOnce, type WatcherState } from "../components/revWatcher";
import type { OntologyResp } from "../components/ontFrame";

const frameOf = (rev: number): OntologyResp => ({
  rev,
  version: 1,
  dirty: false,
  layout: {},
  edgeBends: {},
  edgePins: {},
  states: {},
  deleted: [],
  action_changes: { added: [], overwritten: [], removed: [] },
  object_types: {},
  link_types: {},
});

const stateOf = (over?: Partial<WatcherState>): WatcherState => ({ lastRev: 1, etag: '"test-1"', failedOnce: false, ...over });
const idle = { busy: () => false, formBusy: () => false };

const okFetch = (data: OntologyResp, etag?: string) =>
  (async () => ({
    status: 200,
    ok: true,
    json: async () => data,
    headers: { get: (k: string) => (k === "etag" ? (etag ?? null) : null) },
  })) as unknown as typeof fetch;

describe("pollOnce（轮询纯函数核心）", () => {
  it("304：不动，失败标记清零", async () => {
    const r = await pollOnce("test", stateOf({ failedOnce: true }), idle, (async () => ({ status: 304 })) as never);
    expect(r.result.kind).toBe("idle");
    expect(r.state.failedOnce).toBe(false);
    expect(r.state.lastRev).toBe(1);
  });

  it("rev 没变：不动", async () => {
    const r = await pollOnce("test", stateOf(), idle, okFetch(frameOf(1)));
    expect(r.result.kind).toBe("idle");
  });

  it("rev 变了：frame，状态带上新 rev 与响应 etag", async () => {
    const r = await pollOnce("test", stateOf(), idle, okFetch(frameOf(2), '"test-2"'));
    expect(r.result).toEqual({ kind: "frame", data: frameOf(2) });
    expect(r.state).toEqual({ lastRev: 2, etag: '"test-2"', failedOnce: false });
  });

  it("busy：不动（本页正在写不算外部改动）；formBusy：报 formBlocked 但记 rev", async () => {
    const busy = await pollOnce("test", stateOf(), { busy: () => true, formBusy: () => false }, okFetch(frameOf(2)));
    expect(busy.result.kind).toBe("idle");
    expect(busy.state.lastRev).toBe(1);
    const blocked = await pollOnce("test", stateOf(), { busy: () => false, formBusy: () => true }, okFetch(frameOf(2)));
    expect(blocked.result.kind).toBe("formBlocked");
    expect(blocked.state.lastRev).toBe(2);
  });

  it("失败：第一次报 failOnce，连着失败不再报；恢复后失败标记清零", async () => {
    const boom = (async () => {
      throw new Error("HTTP 500");
    }) as never;
    const first = await pollOnce("test", stateOf(), idle, boom);
    expect(first.result.kind).toBe("failOnce");
    expect(first.state.failedOnce).toBe(true);
    const second = await pollOnce("test", first.state, idle, boom);
    expect(second.result.kind).toBe("idle");
    const recovered = await pollOnce("test", second.state, idle, okFetch(frameOf(2)));
    expect(recovered.result.kind).toBe("frame");
  });

  it("!ok 当失败处理", async () => {
    const r = await pollOnce("test", stateOf(), idle, (async () => ({ status: 500, ok: false })) as never);
    expect(r.result.kind).toBe("failOnce");
  });
});
