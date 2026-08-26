// 确定性 —— 注入固定时钟与固定雪花实例时，generate 的「日期段 + 雪花段」输出完全确定：
// 同一输入（同 clock + 同 instanceId）产出逐字节一致；同实例连续发号递增不撞。
// 这是「时间与随机完全注入」的验收：引擎不读系统时钟、不碰 crypto、无共享计数器，
// clock / snowflake 由边界（makeRuntime 覆盖）注入，生产默认仍是真实实现（行为不变）。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupRuntime, setupRuntime, testEnv } from "./helpers";
import { installRuntime, makeRuntime } from "../server/runtime";
import { generateValue } from "../server/features/query/expr";
import { runAction } from "../server/features/action/action";
import { SqliteFixtureDriver } from "../server/infra/fixture";
import type { PropertyDef, OntologyConfig } from "../server/schema/config";

/** 固定时钟：2026-08-25T00:00:00Z（UTC Unix 秒）。now/d 取整后仍是这天。 */
const FIXED_NOW = 1787616000;
/** 固定雪花实例 id：makeSnowflake(clock, 7) 在固定时钟下首个序列值 = 7497804939264028672（已算死）。 */
const FIXED_INSTANCE = 7;
const SF0 = "7497804939264028672";
const SF1 = "7497804939264028673";

/** generate 两段拼装：日期段（now/d）+ 雪花段。 */
const GEN_SPEC: PropertyDef["generate"] = [{ date: "now/d", format: "yyyyMMdd" }, "-", { snowflake: true }];
const EXPECTED = `20260825-${SF0}`;

describe("时间与随机注入（确定性）", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await setupRuntime("ontos-det-", { clock: () => FIXED_NOW, instanceId: FIXED_INSTANCE });
  });
  afterEach(async () => {
    await cleanupRuntime(tmp);
  });

  it("generateValue：固定时钟 + 固定雪花实例 → 精确拼接；同实例连续发号递增不撞", async () => {
    const env = testEnv();
    const ctx = { clock: env.clock, snowflake: env.snowflake };
    const def: PropertyDef = { type: "string", generate: GEN_SPEC };
    expect(await generateValue("ticket", "ticket_no", def, ctx)).toBe(EXPECTED); // 日期来自假时钟、雪花来自 (clock, instanceId, seq=0)
    expect(await generateValue("ticket", "ticket_no", def, ctx)).toBe(`20260825-${SF1}`); // 同实例同毫秒：序列递增不撞
  });

  it("注入固定雪花源：同一输入连跑两次逐字节一致", async () => {
    await installRuntime(makeRuntime({ cwd: tmp, clock: () => FIXED_NOW, instanceId: FIXED_INSTANCE, snowflake: () => "FIXED-SF" }));
    const env = testEnv();
    const ctx = { clock: env.clock, snowflake: env.snowflake };
    const def: PropertyDef = { type: "string", generate: GEN_SPEC };
    expect(await generateValue("ticket", "ticket_no", def, ctx)).toBe("20260825-FIXED-SF");
    expect(await generateValue("ticket", "ticket_no", def, ctx)).toBe("20260825-FIXED-SF"); // 逐字节一致
  });

  it("runAction 经 create 效应落库：业务编号（日期段+雪花段）精确确定，连续两次递增不撞", async () => {
    const env = testEnv();
    const config: OntologyConfig = {
      object_types: {
        ticket: {
          kind: "thing",
          identity: "ticket_no",
          properties: {
            ticket_no: { type: "string", generate: GEN_SPEC },
            name: { type: "string" },
          },
          sources: { det: { connection: "det_sys", table: "ticket", pk: "id", fields: { ticket_no: "ticket_no", name: "name" } } },
          actions: {
            open: {
              description: "开单",
              effect: [{ create: { object: "ticket", properties: { ticket_no: { from: "generated" }, name: { from: "request" } } } }],
            },
          },
        },
      },
      link_types: {},
    };
    // 同一 env（同 clock + 同 instanceId）连开两单：首单精确等于 EXPECTED（seq=0），次单序列递增（seq=1）不撞
    const driver = new SqliteFixtureDriver();
    const det = driver.register("det_sys");
    det.exec(`CREATE TABLE ticket (id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_no TEXT, name TEXT)`);
    const r1 = await runAction(env, config, driver, { action: "open", object: "ticket", identity: "T-1", request: { name: "测试单" } });
    expect(r1.ok).toBe(true);
    const r2 = await runAction(env, config, driver, { action: "open", object: "ticket", identity: "T-2", request: { name: "测试单" } });
    expect(r2.ok).toBe(true);
    const rows = await driver.select("det_sys", "ticket", ["ticket_no", "name"], []);
    expect(rows[0]).toEqual({ ticket_no: EXPECTED, name: "测试单" }); // 日期来自假时钟、雪花来自 (clock, instanceId, seq=0)
    expect(rows[1].ticket_no).toBe(`20260825-${SF1}`); // 同实例连续发号：递增不撞
    expect(rows[1].ticket_no).not.toBe(rows[0].ticket_no);
  });
});
