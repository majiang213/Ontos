// 无状态化验收 —— 两个独立 env（模拟实例 A / B）共享同一份元库：无内存态互见，全部状态在 DB。
// ① rev 持久化 + base_rev 冲突跨实例一致；② 发布后另一实例立即可见（无内存缓存）；
// ③ 画布路径（无 base_rev）冲突自动重读重试：双方改动都在（合并）；④ UI 态 op 与内容 op 并发：内容推进 rev、UI 态重试成功。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupRuntime, setupRuntime, testEnv } from "./helpers";

const WS = "test";

let tmp: string;
beforeEach(async () => {
  tmp = await setupRuntime("ontos-stateless-");
});
afterEach(async () => {
  await cleanupRuntime(tmp);
});

describe("无状态化（跨实例语义）", () => {
  it("rev 持久化 + base_rev 冲突跨实例一致：A 编辑后 B 用旧 base_rev 被拒，重读再写成功", async () => {
    const envA = testEnv(); // 实例 A
    const envB = testEnv(); // 实例 B（同一份元库，无内存态互见）
    const { editDraft } = await import("../server/features/ontology/editDraft");
    const { getRev, getDraft } = await import("../server/features/ontology/current");

    const r0 = await getRev(envA, WS);
    // A 编辑：rev 0→1
    const a1 = await editDraft(envA, { op: "create_object", name: "vendor", kind: "thing" }, WS);
    expect(a1.code).toBe(200);
    expect(await getRev(envB, WS)).toBe(r0 + 1); // B 看到的 rev 与 A 一致（rev 在 DB，不在进程）
    // B 用旧 base_rev 写 → 422 草稿已变（永不覆盖）
    const bStale = await editDraft(envB, { op: "add_property", object: "vendor", name: "v1", type: "string" }, WS, { base_rev: r0 });
    expect(bStale.code).toBe(422);
    expect(bStale.message).toMatch(/草稿已变/);
    // B 重读再写成功
    const b2 = await editDraft(envB, { op: "add_property", object: "vendor", name: "v1", type: "string" }, WS, { base_rev: await getRev(envB, WS) });
    expect(b2.code).toBe(200);
    const d = (await getDraft(envA, WS)).draft; // A 也能看到 B 的写入（读库水合）
    expect(d.object_types.vendor.properties.v1).toBeDefined();
  });

  it("发布后另一实例立即可见（无内存缓存）；画布路径并发：冲突自动重试，双方改动都在", async () => {
    const envA = testEnv();
    const envB = testEnv();
    const { editDraft } = await import("../server/features/ontology/editDraft");
    const { publish } = await import("../server/features/ontology/versions");
    const { getPublished, getRev, getDraft } = await import("../server/features/ontology/current");

    // A 创建 + 发布 v2
    expect((await editDraft(envA, { op: "create_object", name: "vendor", kind: "thing" }, WS)).code).toBe(200);
    const pub = await publish(envA, WS);
    expect(pub.code).toBe(200);
    // B 立即看到 v2（每请求读库，无内存缓存）
    expect((await getPublished(envB, WS)).version).toBe(2);
    expect((await getPublished(envB, WS)).config.object_types.vendor).toBeDefined();

    // 画布路径（无 base_rev）并发：A 加字段 va、B 加字段 vb——CAS 冲突自动重读重试，两个都落地
    const rev = await getRev(envA, WS);
    const [ra, rb] = await Promise.all([
      editDraft(envA, { op: "add_property", object: "vendor", name: "va", type: "string" }, WS),
      editDraft(envB, { op: "add_property", object: "vendor", name: "vb", type: "string" }, WS),
    ]);
    expect([ra.code, rb.code].sort()).toEqual([200, 200]); // 画布路径冲突不拒：自动重试后都成功（后写叠加应用）
    const d = (await getDraft(envA, WS)).draft;
    expect(d.object_types.vendor.properties.va).toBeDefined();
    expect(d.object_types.vendor.properties.vb).toBeDefined(); // 双方改动都在（合并，互不覆盖）
    expect(await getRev(envA, WS)).toBeGreaterThan(rev);
  });

  it("UI 态 op 与内容 op 并发：两 op 都 bump rev，冲突自动重试后双方落地", async () => {
    const envA = testEnv();
    const envB = testEnv();
    const { editDraft } = await import("../server/features/ontology/editDraft");
    const { getRev, getDraft } = await import("../server/features/ontology/current");

    expect((await editDraft(envA, { op: "create_object", name: "vendor", kind: "thing" }, WS)).code).toBe(200);
    const rev = await getRev(envA, WS);
    const [ra, rb] = await Promise.all([
      editDraft(envA, { op: "add_property", object: "vendor", name: "note", type: "string" }, WS), // 内容 op：rev+1
      editDraft(envB, { op: "save_layout", positions: { vendor: { x: 1, y: 2 } } }, WS), // UI 态 op：也 bump rev，冲突自动重试
    ]);
    expect(ra.code).toBe(200);
    expect(rb.code).toBe(200); // UI 态 op 冲突自动重试成功
    expect(await getRev(envA, WS)).toBe(rev + 2); // 内容 op 与 UI 态 op 各推进一次
    const state = await getDraft(envA, WS);
    expect(state.draft.object_types.vendor.properties.note).toBeDefined();
    expect(state.layout.vendor).toEqual({ x: 1, y: 2 }); // 摆位也落地
  });

  it("并发双发布：版本链只前进一版；CAS 败者 422，重试按「已发布」收尾（无幽灵版本行）", async () => {
    const envA = testEnv();
    const envB = testEnv();
    const { editDraft } = await import("../server/features/ontology/editDraft");
    const { publish } = await import("../server/features/ontology/versions");
    const { getRev, getDraft } = await import("../server/features/ontology/current");

    expect((await editDraft(envA, { op: "create_object", name: "vendor", kind: "thing" }, WS)).code).toBe(200);
    const before = (await envA.meta.listVersions(WS)).length;
    const [ra, rb] = await Promise.all([publish(envA, WS), publish(envB, WS)]);
    // 两方都从同一工作行读出：要么 CAS 输家 422、赢家 200；要么输家 CAS 也赢但插行撞唯一，按成功收尾——只可能是 200/422 或 200/200
    expect([ra.code, rb.code].sort()).toSatisfy((codes: number[]) => codes.every((c) => c === 200 || c === 422));
    // 版本链只前进一版：没有幽灵行（旧顺序下 422 的那次发布已推进 MAX(version)，重试会再插一版）
    const after = await envA.meta.listVersions(WS);
    expect(after.length).toBe(before + 1);
    // 422 的一方重试：工作副本已被赢家清空（dirty=false），按「已发布」成功收尾，不再插版
    const loser = ra.code === 200 ? rb : ra;
    if (loser.code === 422) {
      const retry = await publish(envA, WS);
      expect(retry.code).toBe(200);
      expect((await envA.meta.listVersions(WS)).length).toBe(before + 1); // 重试不产新版本
    }
    // 草稿干净、已发布版本是新的
    expect((await getDraft(envA, WS)).dirty).toBe(false);
    expect((await getPublishedOf(envA)).version).toBe(before + 1);
  });
});

async function getPublishedOf(env: ReturnType<typeof testEnv>): Promise<{ version: number }> {
  return (await import("../server/features/ontology/current")).getPublished(env, WS);
}
