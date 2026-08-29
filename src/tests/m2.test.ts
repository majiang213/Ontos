// M2 测试：配置三视图、LLM 演示实现、生成对象导入草稿。

import { describe, expect, it } from "vitest";
import { load } from "js-yaml";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { configSchema } from "../server/schema/config";
import { enumValueKey, enumValueLabel } from "../server/schema/config";
import { listClasses, readClass, search } from "../server/features/ontology/views";
import { VERDICT_LABELS, Verdict } from "../server/schema/verdict";
import { conclusionsAbout, liveConclusions } from "../server/features/ontology/classConclusions";
import { DemoLlm } from "../server/infra/llm/demo";
import { classStages, explainWhen, moveStageItem } from "../server/features/ontology/stages";

const config = configSchema.parse(load(readFileSync(join(process.cwd(), "src/server/config/ontology.yaml"), "utf8")));

const equipmentSrcLabel = (key: string) => {
  const s = config.object_types.equipment.sources?.[key];
  return s ? `${s.connection}.${s.table}` : key;
};

describe("classStages（类上的阶段从配置读）", () => {
  it("种子设备：在途、在役、报废三条，不限两条", () => {
    const s = classStages(config, "equipment")!;
    expect(s.property).toBe("status");
    expect(s.items.map((i) => i.value)).toEqual(["in_transit", "in_service", "scrapped"]);
    expect(s.items.map((i) => i.label)).toEqual(["在途", "在役", "报废"]); // 中文名从值域项带出来
    expect(s.items[0].when).toEqual({ purchase: true, device: false });
    expect(s.items[1].when).toEqual({ device: true });
    expect(s.items[2].when).toEqual({ device: { mark: "scrapped" } });
  });
  it("没有转化的类没有阶段", () => {
    expect(classStages(config, "department")).toBeNull();
  });
  it("附带出向转化：converted 把在途转为在役，执行动作是 convert", () => {
    const s = classStages(config, "equipment")!;
    expect(s.conversions).toEqual([{ link: "converted", from: "in_transit", to: "in_service", action: "convert" }]);
  });
});

describe("explainWhen（阶段条件的全文白话）", () => {
  it("布尔规则说哪个源有这台、没有这台", () => {
    const s = classStages(config, "equipment")!;
    expect(explainWhen(s.items[0].when, equipmentSrcLabel)).toBe("purchase_sys.po_item 有这台、device_sys.device 没有这台");
    expect(explainWhen(s.items[1].when, equipmentSrcLabel)).toBe("device_sys.device 有这台");
  });
  it("嵌套条件完整展开，不再「按规则」", () => {
    const s = classStages(config, "equipment")!;
    expect(explainWhen(s.items[2].when, equipmentSrcLabel)).toBe("device_sys.device 有这台，且 mark 是 scrapped");
  });
});

describe("moveStageItem（阶段重排）", () => {
  it("中文名随块走；越界原样返回；不动原数组", () => {
    const items = [
      { value: "a", when: { x: true }, label: "甲" },
      { value: "b", when: { y: true } },
      { value: "c", when: { z: true }, label: "丙" },
    ];
    const moved = moveStageItem(items, 0, 1);
    expect(moved.map((i) => i.value)).toEqual(["b", "a", "c"]);
    expect(moved[1].label).toBe("甲"); // 名字跟着块，不丢
    expect(moved[0].label).toBeUndefined();
    expect(items.map((i) => i.value)).toEqual(["a", "b", "c"]); // 原数组不动
    expect(moveStageItem(items, 0, -1)).toBe(items); // 越界原样
  });
});

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
    expect(status?.values?.map((x) => enumValueKey(x))).toContain("in_service");
    expect(status?.values?.map((x) => enumValueLabel(x))).toContain("在役"); // 值域项的中文名跟着出来
    const inWarranty = v.properties.find((p) => p.name === "in_warranty");
    expect(inWarranty?.derived).toBe("filter");
    expect(v.relations.map((r) => r.name)).toContain("belongs_to");
    expect(v.relations.map((r) => r.name)).toContain("covered_by"); // 反向名也在
    expect(v.actions.map((a) => a.name)).toContain("convert");
    expect(v.class_conclusions).toEqual([]);
    expect(v).not.toHaveProperty("sources");
    const text = JSON.stringify(v);
    expect(text).not.toContain("po_item"); // 源表名不出视图
    expect(text).not.toContain("status_one"); // 公理不出视图
  });

  it("读取一个类：带上它参与的类与类结论；死类的行滤掉", () => {
    const cfg = structuredClone(config);
    cfg.class_conclusions = [
      { kind: "homonym", classes: ["equipment", "person"] },
      { kind: "homonym", classes: ["ghost", "person"] },
      { kind: "overlap", classes: ["equipment", "person"], shared: "missing_shared" },
    ];
    expect(liveConclusions(cfg)).toEqual([{ kind: "homonym", classes: ["equipment", "person"] }]);
    expect(conclusionsAbout(cfg, "equipment")).toEqual([{ kind: "homonym", classes: ["equipment", "person"] }]);
    expect(readClass(cfg, "equipment").class_conclusions).toEqual([{ kind: "homonym", classes: ["equipment", "person"] }]);
    expect(readClass(cfg, "department").class_conclusions).toEqual([]);
  });

  it("检索按名字与说明命中", () => {
    expect(search(config, "设备").classes).toContain("equipment");
    expect(search(config, "转化").relations).toContain("converted");
    expect(search(config, "不存在的东西").classes).toEqual([]);
  });
});

describe("真模型实现 AiSdkLlm（注入假 generate，驱动真实出槽校验）", () => {
  const fakeModel = { modelId: "test-model" } as never;

  it("合法产出过闸；乱说话的产出被 Zod 拒绝（模型当顾问不当计算器）", async () => {
    const { AiSdkLlm } = await import("../server/infra/llm/aiSdk");
    const good = { object: "equipment", filter: { status: "in_service" }, properties: ["name"] };
    // 围栏 + 闲话的文本也抠得出 JSON（真模型常这么回）
    const slot = new AiSdkLlm(fakeModel, (async () => ({ text: `结果如下：\n\`\`\`json\n${JSON.stringify(good)}\n\`\`\`` })) as never);
    expect((await slot.nlToQuery("在役设备", config, "test")).object).toBe("equipment");
    const bad = new AiSdkLlm(fakeModel, (async () => ({ text: JSON.stringify({ object: 123 }) })) as never);
    await expect(bad.nlToQuery("x", config, "test")).rejects.toThrow();
    const prose = new AiSdkLlm(fakeModel, (async () => ({ text: "这个问题我答不了。" })) as never);
    await expect(prose.nlToQuery("x", config, "test")).rejects.toThrow(/JSON/);
  });

  it("getLlm：没 Key 时 test 走演示实现、其他空间报错；有 key 没指定模型报错；有 key 有模型走真模型", async () => {
    const { getLlm } = await import("../server/runtime"); // 实现选择收在组合根，引擎不自查
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENAI_MODEL;
    try {
      expect(getLlm("test").name).toBe("demo-演示实现"); // 演示行为按空间绑定：没 Key 的 test 走剧本
      expect(() => getLlm("default")).toThrow(/需要模型 Key/); // 其他空间没 Key 直接报错，不静默顶替
      process.env.OPENAI_API_KEY = "test-key";
      expect(() => getLlm("default")).toThrow(/OPENAI_MODEL/);
      process.env.OPENAI_MODEL = "test-model";
      expect(getLlm("default").name).toContain("ai-sdk:");
      expect(getLlm("test").name).toContain("ai-sdk:"); // 有 Key 时 test 也走真模型
    } finally {
      // 自清假 key（setup.offline 的 afterEach 是兜底，不靠它）
      delete process.env.OPENAI_API_KEY;
      delete process.env.OPENAI_MODEL;
    }
  });

  it("演示剧本只服务 test 空间：别的空间即使有 equipment 类也拒（不静默编成演示查询）", async () => {
    const { DemoLlm } = await import("../server/infra/llm/demo");
    const slot = new DemoLlm();
    // 回归：守卫曾是类名巧合——config 里有 equipment 就放行，任何问法都被编成演示剧本（错答案）
    await expect(slot.nlToQuery("随便问点什么", config, "default")).rejects.toThrow(/只属于 test 演示空间/);
    await expect(slot.nlToQuery("随便问点什么", config, "sandbox")).rejects.toThrow(/只属于 test 演示空间/);
  });

  it("剧本只对上了类的演示问题编得动：空配置下不编幽灵查询，明说该配模型 Key", async () => {
    const { DemoLlm } = await import("../server/infra/llm/demo");
    const slot = new DemoLlm();
    await expect(slot.nlToQuery("在途设备多少台", { object_types: {}, link_types: {} } as never, "test")).rejects.toThrow(/演示实现只覆盖演示剧本/);
  });
});

describe("撞名消解与 prompt 枚举（PR3）", () => {
  it("disambiguateClassNames：撞占用改 {connection}_{table}，仍撞补 _2，不占用不动；无源类退 _2", async () => {
    const { disambiguateClassNames } = await import("../server/infra/llm/llm");
    const obj = {
      kind: "thing",
      identity: "cust_no",
      properties: { cust_no: { type: "string" } },
      sources: { s: { connection: "crm_sys", table: "customer", fields: { cust_no: "cust_no" } } },
    } as never;
    expect(Object.keys(disambiguateClassNames({ customer: obj }, ["customer"]))).toEqual(["crm_sys_customer"]);
    expect(Object.keys(disambiguateClassNames({ customer: obj }, ["customer", "crm_sys_customer"]))).toEqual(["crm_sys_customer_2"]);
    expect(Object.keys(disambiguateClassNames({ customer: obj }, []))).toEqual(["customer"]);
    const bare = { kind: "thing", properties: {} } as never; // 模型产的无源类：没有第一条源可取名
    expect(Object.keys(disambiguateClassNames({ customer: bare }, ["customer"]))).toEqual(["customer_2"]);
  });

  it("nlToQuery 的 prompt 带属性类型与枚举 values（过滤值按 values 编，不写中文）", async () => {
    const { AiSdkLlm } = await import("../server/infra/llm/aiSdk");
    const fakeModel = { modelId: "test-model" } as never;
    let seen = "";
    const slot = new AiSdkLlm(fakeModel, (async (args: { prompt: string }) => {
      seen = args.prompt;
      return { text: JSON.stringify({ object: "equipment" }) };
    }) as never);
    await slot.nlToQuery("在役设备", config, "test");
    expect(seen).toContain('"type"');
    expect(seen).toContain('"values"');
    expect(seen).toContain("in_service"); // equipment.status 的枚举值进了 prompt
  });

  it("proposePair 的 prompt 带交集率与判定顺序，零温度固定种子，空表不要只因 0% 判同形异义", async () => {
    const { AiSdkLlm } = await import("../server/infra/llm/aiSdk");
    const fakeModel = { modelId: "test-model" } as never;
    let seen: { prompt?: string; temperature?: number; seed?: number } = {};
    const slot = new AiSdkLlm(fakeModel, (async (args: { prompt: string; temperature?: number; seed?: number }) => {
      seen = args;
      return { text: JSON.stringify({ class_a: "device", class_b: "asset", tendency: "same", reason: "空表不算不相干" }) };
    }) as never);
    const advice = await slot.proposePair({
      class_a: { name: "device", sources: ["device_sys"], fields: ["sn"], enums: [] },
      class_b: { name: "asset", sources: ["asset_sys"], fields: ["sn"], enums: [] },
      overlap: { rate: 0, count_a: 100, count_b: 0, count_hit: 0 },
      base: { tendency: Verdict.Overlap, reason: "字段部分重合" },
    });
    expect(advice.tendency).toBe(Verdict.Same);
    expect(seen.temperature).toBe(0); // 同一对同一份证据，答案必须唯一：采样方差压没
    expect(seen.seed).toBe(42);
    expect(seen.prompt).toContain("交集率");
    expect(seen.prompt).toContain("有一侧取不出取值");
    expect(seen.prompt).toContain("判定顺序");
    expect(seen.prompt).toContain("第一版建议");
    expect(seen.prompt).toContain(`命中大于零不许给${VERDICT_LABELS[Verdict.NameSimilar]}`);
    expect(seen.prompt).toContain("命中为零不许给部分重叠");
    expect(seen.prompt).toContain("keep");
    expect(seen.prompt).toContain("stage.earlier");
  });

  it("AiSdkLlm 失败落盘：原始产出写临时目录，OPENAI_API_KEY 字面值打码", async () => {
    const { AiSdkLlm } = await import("../server/infra/llm/aiSdk");
    const { readdirSync, readFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const fakeModel = { modelId: "test-model" } as never;
    process.env.OPENAI_API_KEY = "sk-testsecret";
    try {
      const slot = new AiSdkLlm(fakeModel, (async () => {
        throw new Error("401 invalid key sk-testsecret"); // 上游报错把 key 带回来的情形
      }) as never);
      await expect(slot.nlToQuery("x", config, "test")).rejects.toThrow(/401/);
      const dir = join(tmpdir(), "ontos-llm-fail");
      const files = readdirSync(dir).filter((f) => f.includes("nlToQuery"));
      expect(files.length).toBeGreaterThan(0);
      const text = readFileSync(join(dir, files[files.length - 1]), "utf8");
      expect(text).toContain("nlToQuery");
      expect(text).not.toContain("sk-testsecret"); // 密钥打码
      expect(text).toContain("***");
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });
});

describe("LLM 演示实现（离线）", () => {
  const slot = new DemoLlm();

  it("演示四问编成正确查询（整体比对，不许片段正确）", async () => {
    expect(await slot.nlToQuery("在役设备及其所属部门", config, "test")).toEqual({
      object: "equipment",
      properties: ["name"],
      filter: { status: "in_service" },
      expand: [{ relation: "belongs_to", properties: ["name"] }],
    });
    expect(await slot.nlToQuery("还有多少在途设备", config, "test")).toEqual({
      object: "equipment",
      properties: ["name", "serial_no"],
      filter: { status: "in_transit" },
    });
    expect(await slot.nlToQuery("哪些设备过保了", config, "test")).toEqual({
      object: "equipment",
      properties: ["name", "serial_no"],
      filter: { in_warranty: false },
    });
    expect(await slot.nlToQuery("每个部门多少台在役设备", config, "test")).toEqual({
      object: "equipment",
      filter: { status: "in_service" },
      aggregate: { group_by: ["dept"], metrics: [{ count: "*" }] },
    });
  });

  it("逆向建模：不按列名形状猜识别字段（_no 结尾同样可能是代理键），整数主键宁缺勿错", async () => {
    const draft = await slot.proposeObjects([
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
    expect(draft.meter.identity).toBeUndefined(); // meter_no 形状像编号证明不了唯一：键留待人定
    expect(draft.meter.properties).not.toHaveProperty("id"); // 主键不当属性
    expect(draft.meter.properties.reading.type).toBe("number");
    expect(draft.meter.sources?.mes_sys.table).toBe("meter"); // 没猜到键不丢来源：键在待确认面板①定（发布闸拦有源无键）
  });

  it("逆向建模：整数自增主键不当唯一键（po_item 形状：po_id 是行号，sn 才是序列号）", async () => {
    const draft = await slot.proposeObjects([
      {
        connection: "purchase_sys",
        table: {
          name: "po_item",
          columns: [
            { name: "po_id", type: "INTEGER", pk: true },
            { name: "item_name", type: "TEXT", pk: false },
            { name: "sn", type: "TEXT", pk: false, comment: "设备序列号" },
          ],
        },
      },
    ]);
    expect(draft.po_item.identity).toBeUndefined(); // po_id 跨源对不上号，不能当 identity
    expect(draft.po_item.properties.sn.description).toBe("设备序列号");
    expect(draft.po_item.sources?.purchase_sys.pk).toBe("po_id"); // pk 照记：仅供台账与展示
  });

  it("逆向建模：列注释存成字段说明，没注释的字段说明为空", async () => {
    const draft = await slot.proposeObjects([
      {
        connection: "mes_sys",
        table: {
          name: "meter",
          columns: [
            { name: "meter_no", type: "TEXT", pk: true, comment: "表编号" },
            { name: "reading", type: "INTEGER", pk: false, comment: "读数" },
            { name: "note", type: "TEXT", pk: false }, // 无注释
          ],
        },
      },
    ]);
    expect(draft.meter.properties.meter_no.description).toBe("表编号"); // 主键是业务编号时破格进属性，注释跟上
    expect(draft.meter.properties.reading.description).toBe("读数");
    expect(draft.meter.properties.note.description).toBeUndefined();
  });

  it("逆向建模：occupied 已占用的类名撞名带连接前缀（跨次生成），不占用仍用表名", async () => {
    const table = { name: "customer", columns: [{ name: "cust_no", type: "TEXT", pk: true }] };
    const hit = await slot.proposeObjects([{ connection: "crm_sys", table }], ["customer"]);
    expect(hit.customer).toBeUndefined();
    expect(hit.crm_sys_customer?.identity).toBe("cust_no");
    const free = await slot.proposeObjects([{ connection: "crm_sys", table }]);
    expect(free.customer).toBeTruthy(); // 不占用：不乱加前缀
  });

  it("候选对建议：字段重合才成对；同一库两张表也可以成对", async () => {
    const pairs = await slot.proposePairs([
      { name: "a", sources: ["s1"], fields: ["sn", "name"], enums: [] },
      { name: "b", sources: ["s2"], fields: ["sn", "name", "status"], enums: [] },
      { name: "c", sources: ["s1"], fields: ["sn", "name"], enums: [] }, // 与 a 同一连接、不同类
      { name: "d", sources: ["s2"], fields: ["xyz"], enums: [] },
    ]);
    // a-b、b-c 跨源字段重合；a-c 同一库也可以成对；d 字段对不上
    expect(pairs.map((p) => `${p.class_a}-${p.class_b}`).sort()).toEqual(["a-b", "a-c", "b-c"]);
    expect(pairs.find((p) => p.class_a === "a" && p.class_b === "b")?.tendency).toBe(Verdict.Stage); // 含状态字段
  });

  it("候选对建议：留下谁由建议给；谁早、时期名不猜（引擎占位 early/late）", async () => {
    const pairs = await slot.proposePairs([
      { name: "shared_x", sources: ["s1"], fields: ["sn", "name"], enums: [] },
      { name: "device", sources: ["s2"], fields: ["sn", "name"], enums: [] },
      { name: "po", sources: ["s3"], fields: ["sn", "name"], enums: [] },
      { name: "dev", sources: ["s4"], fields: ["sn", "name", "status"], enums: [] },
    ]);
    const same = pairs.find((p) => p.class_a === "shared_x" && p.class_b === "device");
    expect(same?.tendency).toBe(Verdict.Same);
    expect(same?.keep).toBe("device"); // 不留下 shared_
    expect(same?.stage).toBeUndefined(); // 演示实现不产时期名：词与序交给引擎占位/人定

    const stage = pairs.find((p) => p.class_a === "po" && p.class_b === "dev");
    expect(stage?.tendency).toBe(Verdict.Stage); // 有状态类字段只是召回偏置
    expect(stage?.keep).toBe("dev"); // 字段更多
    expect(stage?.stage).toBeUndefined(); // 谁早谁晚、时期名都不猜
  });

  it("看过交集率再建议：命中为零不改口同形异义；空表不否定类等价", async () => {
    const a = { name: "device", sources: ["device_sys"], fields: ["sn", "name"], enums: [] };
    const b = { name: "asset", sources: ["asset_sys"], fields: ["sn", "name"], enums: [] };
    const empty = await slot.proposePair({ class_a: a, class_b: b, overlap: { rate: 0, count_a: 100, count_b: 0, count_hit: 0 } });
    expect(empty.tendency).toBe(Verdict.Same);
    expect(empty.reason).toContain("还没有行");
    const miss = await slot.proposePair({ class_a: a, class_b: b, overlap: { rate: 0, count_a: 100, count_b: 80, count_hit: 0 } });
    expect(miss.tendency).toBe(Verdict.Same); // 不是同一批，但不能据此否定同一
    expect(miss.reason).toContain("不是同一批");
    const mid = await slot.proposePair({
      class_a: { name: "po", sources: ["purchase_sys"], fields: ["sn", "name"], enums: [] },
      class_b: { name: "dev", sources: ["device_sys"], fields: ["sn", "name", "status"], enums: [] },
      overlap: { rate: 0.33, count_a: 121, count_b: 100, count_hit: 40 },
    });
    expect(mid.tendency).toBe(Verdict.Stage);
    expect(mid.stage).toBeUndefined(); // 演示实现仍不产时期名与先后（引擎占位）
    expect(empty.keep).toBe("device"); // 字段一样多，留下先写的
  });

  it("看过交集率再建议：命中为零则数据不支持部分重叠，空表改口同一", async () => {
    const advice = await slot.proposePair({
      class_a: { name: "asset", sources: ["asset_sys"], fields: ["asset_id", "sn"], enums: [] },
      class_b: { name: "device", sources: ["device_sys"], fields: ["dev_id", "serial_no"], enums: [] },
      overlap: { rate: 0, count_a: 0, count_b: 100, count_hit: 0 },
      base: { tendency: Verdict.Overlap, reason: "第一版按语义对应给的" },
    });
    expect(advice.tendency).toBe(Verdict.Same);
    expect(advice.reason).toContain("还没有行");
  });

  it("看过交集率再建议：接近全交不压过第三问——有状态字段且第一版是生命周期则维持生命周期", async () => {
    const a = { name: "po", sources: ["purchase_sys"], fields: ["sn", "name"], enums: [] };
    const b = { name: "dev", sources: ["device_sys"], fields: ["sn", "name", "status"], enums: [] };
    const full = { rate: 0.92, count_a: 100, count_b: 100, count_hit: 92 };
    const stage = await slot.proposePair({ class_a: a, class_b: b, overlap: full, base: { tendency: Verdict.Stage, reason: "字段像阶段" } });
    expect(stage.tendency).toBe(Verdict.Stage); // 合成表「是 | 命中大于零 | 是 → 阶段」，比率不单独压过第三问
    expect(stage.reason).toContain(`维持${VERDICT_LABELS[Verdict.Stage]}`);
    const same = await slot.proposePair({ class_a: a, class_b: b, overlap: full, base: { tendency: Verdict.Same, reason: "字段几乎全同" } });
    expect(same.tendency).toBe(Verdict.Same); // 第三问不是「是」——全交只答同一批，维持同一
  });

  it("看过交集率再建议：两边都有行、命中为零，阶段立不住——改口同一（空表才沉默）", async () => {
    const advice = await slot.proposePair({
      class_a: { name: "po", sources: ["purchase_sys"], fields: ["sn", "name"], enums: [] },
      class_b: { name: "dev", sources: ["device_sys"], fields: ["sn", "name", "status"], enums: [] },
      overlap: { rate: 0, count_a: 100, count_b: 80, count_hit: 0 },
      base: { tendency: Verdict.Stage, reason: "字段像阶段" },
    });
    expect(advice.tendency).toBe(Verdict.Same); // 阶段要求同一个体两头都在；命中为零不支持阶段
    expect(advice.reason).toContain("不是同一批");
  });
});
