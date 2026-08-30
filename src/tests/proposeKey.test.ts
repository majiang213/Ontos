// 唯一键识别（propose_key）：候选列生成、数据试算（表内唯一性 + 候选对命中）、演示实现机械建议、端到端识别。
// 与交集率的分工：交集率在键定之后；识别在键定之前（建议，人确认才落库）。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupRuntime, freshStore, setupRuntime, unwrap } from "./helpers";
import { candidateKeyColumns, proposeKeyFor } from "../server/features/integrate/proposeKey";
import { DemoLlm } from "../server/infra/llm/demo";
import type { TableInfo } from "../server/infra/driver";
import type { KeyCandidateShot } from "../server/infra/llm/llm";
import type { ObjectType } from "../server/schema/config";

const WORKSPACE = "test";

let tmp: string;

beforeEach(async () => {
  tmp = await setupRuntime("ontos-key-");
});

afterEach(async () => {
  await cleanupRuntime(tmp);
});

const table = (name: string, columns: TableInfo["columns"]): TableInfo => ({ name, columns });

describe("candidateKeyColumns（候选列进门凭据）", () => {
  const cls: ObjectType = {
    kind: "thing",
    properties: {
      sn: { type: "string", description: "设备序列号" },
      po_id: { type: "number" },
      code: { type: "number" },
      item_name: { type: "string" },
      status: { type: "string", derived: { a: "x" } },
    },
    sources: {
      s: { connection: "purchase_sys", table: "po_item", pk: "po_id", fields: { sn: "sn", po_id: "po_id", code: "code", item_name: "item_name", status: "status" } },
    },
  };
  const tables = new Map([
    ["purchase_sys.po_item", table("po_item", [
      { name: "po_id", type: "INTEGER", pk: true },
      { name: "sn", type: "TEXT", pk: false, unique: true },
      { name: "code", type: "INTEGER", pk: false, unique: true },
      { name: "item_name", type: "TEXT", pk: false },
    ])],
  ]);

  it("唯一约束列进门（非整数与整数都算）；整数主键与派生字段不进；名称/注释召回只认非整数列", () => {
    const got = candidateKeyColumns(cls, tables).map((c) => c.name);
    expect(got).toContain("sn"); // 唯一约束
    expect(got).toContain("code"); // 唯一约束（整数业务编号也进门，数据验证兜底）
    expect(got).not.toContain("po_id"); // 整数主键：行号，不进门
    expect(got).not.toContain("status"); // 派生字段不能当唯一键
    expect(got).not.toContain("item_name"); // 名字/注释都不带业务编号特征
  });

  it("当前建议无条件进门（模型导入时给的）；注释带编号特征的非整数列也进门", () => {
    const got = candidateKeyColumns(cls, tables, "item_name");
    expect(got.map((c) => c.name)).toContain("item_name");
    const withComment = candidateKeyColumns(
      { kind: "thing", properties: { note: { type: "string" } }, sources: { s: { connection: "purchase_sys", table: "po_item", fields: { note: "note" } } } },
      new Map([["purchase_sys.po_item", table("po_item", [{ name: "note", type: "TEXT", pk: false, comment: "采购单号" }])]])
    );
    expect(withComment.map((c) => c.name)).toContain("note"); // 注释「采购单号」命中召回
  });

  it("未映射进源条目的属性不进门（唯一键要落到每个源）", () => {
    const half: ObjectType = {
      kind: "thing",
      properties: { sn: { type: "string" }, other: { type: "string" } },
      sources: { s: { connection: "purchase_sys", table: "po_item", fields: { sn: "sn" } } }, // other 没映射
    };
    expect(candidateKeyColumns(half, tables).map((c) => c.name)).toEqual(["sn"]);
  });
});

describe("DemoLlm.proposeKey（机械建议规则）", () => {
  const demo = new DemoLlm();
  const cand = (name: string, extra: Partial<KeyCandidateShot> = {}): KeyCandidateShot => ({
    name,
    rows: 100,
    distinct: 100,
    intraUnique: true,
    hits: [],
    ...extra,
  });

  it("单对命中最高者胜；全 0 命中不否定，维持导入时的建议", async () => {
    const s = await demo.proposeKey({
      name: "po_item",
      current: "sn",
      candidates: [
        cand("sn", { unique: true, hits: [{ class_b: "device", column: "serial_no", hit: 40, total_a: 121, total_b: 100 }] }),
        cand("code", { hits: [{ class_b: "device", column: "serial_no", hit: 2, total_a: 121, total_b: 100 }] }),
      ],
    });
    expect(s.key).toBe("sn");
    expect(s.reason).toContain("40");
    expect(s.reason).toContain("硬保证");
    const none = await demo.proposeKey({ name: "po_item", current: "sn", candidates: [cand("sn", { unique: true })] });
    expect(none.key).toBe("sn"); // 0 命中维持 current
    expect(none.reason).toContain("维持");
  });

  it("表内不唯一的候选出局；候选列全部出局给 null", async () => {
    const s = await demo.proposeKey({
      name: "order",
      candidates: [cand("order_no", { rows: 100, distinct: 80, intraUnique: false })],
    });
    expect(s.key).toBeNull();
    expect(s.reason).toContain("重复");
  });

  it("没有候选列给 null；平手时硬信号优先", async () => {
    expect((await demo.proposeKey({ name: "x", candidates: [] })).key).toBeNull();
    const tie = await demo.proposeKey({
      name: "x",
      candidates: [
        cand("code", { hits: [{ class_b: "b", column: "c", hit: 5, total_a: 10, total_b: 10 }] }),
        cand("sn", { unique: true, hits: [{ class_b: "b", column: "c", hit: 5, total_a: 10, total_b: 10 }] }),
      ],
    });
    expect(tie.key).toBe("sn"); // 命中相同，唯一约束优先
  });
});

describe("proposeKeyFor（端到端：候选对试算 + 建议）", () => {
  it("po_item × device：sn 与 serial_no 对上 40 条，建议 sn（硬保证）", async () => {
    const s = await freshStore(tmp);
    await s.editDraft(
      {
        op: "import_objects",
        objects: {
          po_item: {
            kind: "thing",
            properties: { item_name: { type: "string" }, sn: { type: "string" } },
            sources: { purchase_sys: { connection: "purchase_sys", table: "po_item", pk: "po_id", fields: { item_name: "item_name", sn: "sn" } } },
          },
          device_b: {
            kind: "thing",
            properties: { name: { type: "string" }, sn: { type: "string" } },
            sources: { device_sys: { connection: "device_sys", table: "device", pk: "dev_id", fields: { name: "name", sn: "serial_no" } } },
          },
        },
      },
      WORKSPACE
    );
    const r = unwrap(await proposeKeyFor(s.env, WORKSPACE, "po_item"));
    expect(r.key).toBe("sn");
    expect(r.hard).toBe(true); // sn 有唯一约束
    expect(r.reason).toContain("对上 40 条");
    // 试算证据：命中与扫描行数（每源 ≤ KEY_TRIAL_SCAN）
    const sn = r.evidence.find((c) => c.name === "sn")!;
    expect(sn.rows).toBe(121);
    expect(sn.distinct).toBe(121);
    expect(sn.intraUnique).toBe(true);
    expect(sn.hits).toContainEqual(expect.objectContaining({ class_b: "device_b", column: "sn", hit: 40 }));
    // 只建议不落地：草稿的 identity 仍是空
    expect((await s.getDraft(WORKSPACE)).draft.object_types.po_item.identity).toBeUndefined();
  });

  it("没有候选对（画布上无可比对象）：0 命中不否定，建议维持导入时的键", async () => {
    const s = await freshStore(tmp);
    await s.editDraft(
      {
        op: "import_objects",
        objects: {
          po_item: {
            kind: "thing",
            identity: "sn",
            properties: { item_name: { type: "string" }, sn: { type: "string" } },
            sources: { purchase_sys: { connection: "purchase_sys", table: "po_item", pk: "po_id", fields: { item_name: "item_name", sn: "sn" } } },
          },
        },
      },
      WORKSPACE
    );
    const r = unwrap(await proposeKeyFor(s.env, WORKSPACE, "po_item"));
    expect(r.key).toBe("sn"); // 没有对得上号的对，维持导入时的建议
    expect(r.reason).toContain("维持");
  });

  it("表内不唯一的候选（订单号在源里重复）不出建议，key 为 null", async () => {
    const s = await freshStore(tmp);
    // 造一张订单号重复的表：同一采购单号两行（复合键的典型形状，单列不唯一）
    const { SqliteFixtureDriver } = await import("../server/infra/fixture");
    const d = new SqliteFixtureDriver();
    const db = d.register("dup_sys");
    db.exec(`CREATE TABLE dup_order (id INTEGER PRIMARY KEY AUTOINCREMENT, order_no TEXT, line_no TEXT)`);
    const ins = db.prepare(`INSERT INTO dup_order (order_no, line_no) VALUES (?, ?)`);
    ins.run("PO-001", "L1");
    ins.run("PO-001", "L2"); // order_no 在表内重复
    const registry = await s.env.getRegistry(WORKSPACE);
    registry.register("dup_sys", d);
    await s.editDraft(
      {
        op: "import_objects",
        objects: {
          dup_order: {
            kind: "thing",
            properties: { order_no: { type: "string" } },
            sources: { dup_sys: { connection: "dup_sys", table: "dup_order", pk: "id", fields: { order_no: "order_no" } } },
          },
        },
      },
      WORKSPACE
    );
    const r = unwrap(await proposeKeyFor(s.env, WORKSPACE, "dup_order"));
    expect(r.key).toBeNull();
    expect(r.reason).toContain("重复");
    const c = r.evidence.find((x) => x.name === "order_no")!;
    expect(c.rows).toBe(2);
    expect(c.intraUnique).toBe(false);
  });
});
