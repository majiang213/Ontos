// M2 测试：配置三视图、LLM 槽位离线回退、生成对象导入草稿。

import { describe, expect, it } from "vitest";
import { load } from "js-yaml";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { configSchema } from "../server/schema/config";
import { listClasses, readClass, search } from "../server/engine/views";
import { CannedSlot } from "../server/engine/llmSlot";

const config = configSchema.parse(load(readFileSync(join(process.cwd(), "src/server/config/ontology.yaml"), "utf8")));

describe("配置三视图", () => {
  it("列出类：只有名字和说明", () => {
    const list = listClasses(config);
    expect(list.length).toBe(9);
    expect(list[0]).toHaveProperty("name");
    expect(list[0]).not.toHaveProperty("properties");
  });

  it("读取一个类：属性附形式、关系含反向、动作含前置；不含 sources/pk/axioms", () => {
    const v = readClass(config, "equipment");
    const status = v.properties.find((p) => p.name === "status");
    expect(status?.derived).toBe("when");
    expect(status?.values).toContain("in_service");
    const inWarranty = v.properties.find((p) => p.name === "in_warranty");
    expect(inWarranty?.derived).toBe("filter");
    expect(v.relations.map((r) => r.name)).toContain("belongs_to");
    expect(v.relations.map((r) => r.name)).toContain("covered_by"); // 反向名也在
    expect(v.actions.map((a) => a.name)).toContain("convert");
    expect(v).not.toHaveProperty("sources");
    const text = JSON.stringify(v);
    expect(text).not.toContain("po_item"); // 源表名不出视图
    expect(text).not.toContain("status_one"); // 公理不出视图
  });

  it("检索按名字与说明命中", () => {
    expect(search(config, "设备").classes).toContain("equipment");
    expect(search(config, "转化").relations).toContain("converted");
    expect(search(config, "不存在的东西").classes).toEqual([]);
  });
});

describe("真模型槽位 AiSdkSlot（注入假 generate，驱动真实出槽校验）", () => {
  const fakeModel = { modelId: "test-model" } as never;

  it("合法产出过闸；乱说话的产出被 Zod 拒绝（模型当顾问不当计算器）", async () => {
    const { AiSdkSlot } = await import("../server/engine/llmSlot");
    const good = { object: "equipment", filter: { status: "in_service" }, properties: ["name"] };
    const slot = new AiSdkSlot(fakeModel, (async () => ({ object: good })) as never);
    expect((await slot.nlToQuery("在役设备", config)).object).toBe("equipment");
    const bad = new AiSdkSlot(fakeModel, (async () => ({ object: { object: 123 } })) as never);
    await expect(bad.nlToQuery("x", config)).rejects.toThrow();
  });

  it("getSlot：没 OPENAI_API_KEY 回退罐头，有 key 走真模型", async () => {
    const { getSlot } = await import("../server/engine/llmSlot");
    delete process.env.OPENAI_API_KEY;
    expect(getSlot().name).toBe("canned-离线回退");
    process.env.OPENAI_API_KEY = "test-key";
    expect(getSlot().name).toContain("ai-sdk:");
    delete process.env.OPENAI_API_KEY;
  });
});

describe("LLM 槽位离线回退", () => {
  const slot = new CannedSlot();

  it("演示四问编成正确查询（整体比对，不许片段正确）", async () => {
    expect(await slot.nlToQuery("在役设备及其所属部门", config)).toEqual({
      object: "equipment",
      properties: ["name"],
      filter: { status: "in_service" },
      expand: [{ relation: "belongs_to", properties: ["name"] }],
    });
    expect(await slot.nlToQuery("还有多少在途设备", config)).toEqual({
      object: "equipment",
      properties: ["name", "serial_no"],
      filter: { status: "in_transit" },
    });
    expect(await slot.nlToQuery("哪些设备过保了", config)).toEqual({
      object: "equipment",
      properties: ["name", "serial_no"],
      filter: { in_warranty: false },
    });
    expect(await slot.nlToQuery("每个部门多少台在役设备", config)).toEqual({
      object: "equipment",
      filter: { status: "in_service" },
      aggregate: { group_by: ["dept"], metrics: [{ count: "*" }] },
    });
  });

  it("逆向建模：表结构产草稿，识别字段猜编号列，主键不进属性", async () => {
    const draft = await slot.draftObjects([
      {
        connection: "mes_sys",
        table: {
          name: "meter",
          columns: [
            { name: "id", type: "INTEGER", pk: true },
            { name: "meter_no", type: "TEXT", pk: false },
            { name: "reading", type: "INTEGER", pk: false },
          ],
        },
      },
    ]);
    expect(draft.meter.identity).toBe("meter_no");
    expect(draft.meter.properties).not.toHaveProperty("id"); // 主键不当属性
    expect(draft.meter.properties.reading.type).toBe("number");
    expect(draft.meter.sources?.mes_sys.table).toBe("meter");
  });

  it("候选对建议：跨源且字段重合才成对，同源不成对", async () => {
    const pairs = await slot.suggestPairs([
      { name: "a", sources: ["s1"], fields: ["sn", "name"] },
      { name: "b", sources: ["s2"], fields: ["sn", "name", "status"] },
      { name: "c", sources: ["s1"], fields: ["sn", "name"] }, // 与 a 同源
      { name: "d", sources: ["s2"], fields: ["xyz"] },
    ]);
    // a-b 与 b-c：跨源且字段重合过半；a-c 同源不成对；d 字段对不上
    expect(pairs.map((p) => `${p.class_a}-${p.class_b}`).sort()).toEqual(["a-b", "b-c"]);
    expect(pairs[0].tendency).toBe("阶段"); // 含状态字段
  });
});
