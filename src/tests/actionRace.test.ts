// 动作并发原子性回归（R7 卡 1）：
// ① nextSeq 并发出号不重（旧形态 upsert→select 两句之间可交错，并发必重号——本测试在旧实现下确定性失败）；
// ② 并发重发同一 create 动作只插一行（旧裸奔形态两个都过查重、插重复行）。
// 串行化在 runAction 的每空间队列（runtime.actionTails），发号原子性在 meta/stores/seq。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupRuntime, draftEngine, meta, setupRuntime } from "./helpers";

const WS = "test";

let tmp: string;
beforeEach(async () => {
  tmp = await setupRuntime("ontos-race-");
});
afterEach(async () => {
  await cleanupRuntime(tmp);
});

describe("动作并发原子性", () => {
  it("nextSeq 并发 10 个：不重号（恰好 1..10 各一次）", async () => {
    const m = await meta();
    const nums = await Promise.all(Array.from({ length: 10 }, () => m.nextSeq(WS, "race_key")));
    expect([...nums].sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  });

  it("并发重发同一 create（登记新设备）：先到的插入，后到的被前置拦（各源已有此序列号）", async () => {
    const { runAction } = await import("../server/engine/action/action");
    const { getPublished } = await draftEngine();
    const { getDriverRegistry } = await import("../server/engine/infra/connections");
    const m = await meta();
    const config = (await getPublished(WS)).config;
    const registry = await getDriverRegistry(WS);
    // register：create equipment，serial_no 来自 identity——幂等键就是它，是队列护住的那条 check-then-act
    // SN-90002 各源都没有（$exists: false 前置才过）；串行后第二个看到已插入的行，前置 $exists:false 拦下
    const req = { action: "register", object: "equipment", identity: "SN-90002", request: { name: "竞态机床", dept: "D03" } };
    const call = () => runAction(config, registry, req, { ws: WS, nextSequence: (k, s) => m.nextSeq(WS, k, s) });
    const [r1, r2] = await Promise.all([call(), call()]);
    // 旧裸奔形态：两个都过查重、都真插（device 表两行同 serial_no）；串行后：一成一拒
    const oks = [r1.ok, r2.ok].sort();
    expect(oks).toEqual([false, true]);
    const rejected = r1.ok ? r2 : r1;
    expect(rejected.stage).toBe("pre");
    const rows = await registry.select("device_sys", "device", ["serial_no"], [{ column: "serial_no", op: "eq", value: "SN-90002" }]);
    expect(rows.length).toBe(1); // 源库恰一行，没有重复业务行
  });
});
