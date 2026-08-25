// 确定性 —— 注入固定时钟与固定 uuid 源时，generate 的「日期段 + 序列段 + uuid 段」输出完全确定：
// 同一输入连跑两次逐字节一致。这是「时间与随机完全注入」的验收：引擎不读系统时钟、不碰 crypto，
// clock / uuid 由边界（makeRuntime 覆盖）注入，生产默认仍是真实实现（行为不变）。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupRuntime, setupRuntime, testEnv } from "./helpers";
import { generateValue, type EvalContext } from "../server/features/query/expr";
import { runAction } from "../server/features/action/action";
import { SqliteFixtureDriver } from "../server/infra/fixture";
import type { PropertyDef, OntologyConfig } from "../server/schema/config";

/** 固定时钟：2026-08-25T00:00:00Z（UTC Unix 秒）。now/d 取整后仍是这天。 */
const FIXED_NOW = 1787616000;
/** 固定 uuid 源：注入什么就拼什么，不校验形态（引擎不自己生成）。 */
const FIXED_UUID = "11111111-2222-4777-8888-999999999999";

/** generate 三段拼装：字面量 + 日期段（now/d）+ 序列段（start 1 width 4）+ uuid 段。 */
const GEN_SPEC: PropertyDef["generate"] = [
  "B",
  { date: "now/d", format: "yyyyMMdd" },
  "-",
  { sequence: { start: 1, width: 4 } },
  "-",
  { uuid: "v7" },
];
const EXPECTED = `B20260825-0001-${FIXED_UUID}`;

describe("时间与随机注入（确定性）", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await setupRuntime("ontos-det-", { clock: () => FIXED_NOW, uuid: () => FIXED_UUID });
  });
  afterEach(async () => {
    await cleanupRuntime(tmp);
  });

  it("generateValue：固定时钟 + 固定 uuid + 注入发号器 → 精确拼接；连跑两次逐字节一致", async () => {
    const env = testEnv();
    let n = 0;
    const ctx: EvalContext = { clock: env.clock, uuid: env.uuid, nextSequence: () => ++n };
    const def: PropertyDef = { type: "string", generate: GEN_SPEC };
    const v1 = await generateValue("ticket", "ticket_no", def, ctx);
    expect(v1).toBe(EXPECTED); // 日期来自假时钟、序列来自注入发号器、uuid 来自假随机源
    n = 0; // 同一输入重跑：重置计数器，输出必须逐字节一致
    const v2 = await generateValue("ticket", "ticket_no", def, ctx);
    expect(v2).toBe(v1);
  });

  it("runAction 经 create 效应落库：业务编号（日期段+序列段+uuid 段）精确确定，同一输入连跑两次逐字节一致", async () => {
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
    let n = 0;
    const opts = { workspace: "default", nextSequence: (k: string, s?: number) => ++n };
    // 同一输入跑两遍（固定时钟 / 固定 uuid / 重置发号器 / 全新空表）：产物必须逐字节一致
    const runOnce = async () => {
      const driver = new SqliteFixtureDriver();
      const det = driver.register("det_sys");
      det.exec(`CREATE TABLE ticket (id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_no TEXT, name TEXT)`);
      n = 0;
      const res = await runAction(env, config, driver, { action: "open", object: "ticket", identity: "T-1", request: { name: "测试单" } }, opts);
      expect(res.ok).toBe(true);
      return driver.select("det_sys", "ticket", ["ticket_no", "name"], []);
    };
    const rows1 = await runOnce();
    const rows2 = await runOnce();
    expect(rows1).toEqual([{ ticket_no: EXPECTED, name: "测试单" }]); // 日期来自假时钟、序列来自注入发号器、uuid 来自假随机源
    expect(rows2).toEqual(rows1);
  });
});
