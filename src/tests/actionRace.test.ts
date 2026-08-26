// 动作并发原子性回归（无状态化后语义）：
// ① 雪花发号：同实例同毫秒序列递增不撞；不同实例（不同 instanceId）同毫秒不撞——无共享计数器，无需协调；
// ② 并发重发同一 create 动作只插一行：幂等从"进程内队列串行"变为"源表 identity 列唯一索引 + 插入失败重查兜底"。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupRuntime, draftEngine, setupRuntime, testEnv } from "./helpers";
import { makeSnowflake } from "../server/infra/snowflake";

const WORKSPACE = "test";

let tmp: string;
beforeEach(async () => {
  tmp = await setupRuntime("ontos-race-");
});
afterEach(async () => {
  await cleanupRuntime(tmp);
});

describe("动作并发原子性", () => {
  it("雪花发号：同实例同毫秒序列递增不撞；不同实例同毫秒不撞", () => {
    const clock = () => 1787616000; // 固定时钟：所有调用同一毫秒
    const a = makeSnowflake(clock, 1);
    const b = makeSnowflake(clock, 2);
    const first = a();
    expect(a()).not.toBe(first); // 同实例同毫秒：序列递增
    expect(a()).not.toBe(first);
    expect(b()).not.toBe(a()); // 不同实例同毫秒：实例位不同
    const c = makeSnowflake(clock, 3);
    const all = Array.from({ length: 101 }, () => c()); // 同一实例连续 101 个
    expect(new Set(all).size).toBe(all.length); // 同实例同毫秒：序列位 12 位递增，远未耗尽
  });

  it("并发重发同一 create（登记新设备）：两次都 ok、源表恰一行、输的那次带幂等 note", async () => {
    const { runAction } = await import("../server/features/action/action");
    const { getPublished } = await draftEngine();
    const { getDriverRegistry } = await import("../server/infra/connections");
    const env = testEnv();
    const config = (await getPublished(WORKSPACE)).config;
    const registry = await getDriverRegistry(WORKSPACE);
    // register：create equipment，serial_no 来自 identity——幂等键就是它（device.serial_no 有 UNIQUE）
    // SN-90002 各源都没有（$exists: false 前置才过）；并发下两个都过前置，插入时唯一索引拦下后到者，
    // 重查发现行已存在 → 幂等命中（noteAlreadyInserted），源库恰一行
    const req = { action: "register", object: "equipment", identity: "SN-90002", request: { name: "竞态机床", dept: "D03" } };
    const call = () => runAction(env, config, registry, req);
    const [r1, r2] = await Promise.all([call(), call()]);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect([r1, r2].filter((r) => r.projections.some((p) => p.note !== undefined)).length).toBe(1); // 恰好一个带幂等 note
    const rows = await registry.select("device_sys", "device", ["serial_no"], [{ column: "serial_no", op: "eq", value: "SN-90002" }]);
    expect(rows.length).toBe(1); // 源库恰一行，没有重复业务行
  });
});
