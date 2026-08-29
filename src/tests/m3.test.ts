// M3 测试：归一化、交集率（真实读源计算）、裁决写草稿（类等价 / 部分重叠 / 生命周期 / 同形异义 / 跳过）。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupRuntime, draftEngine, setupRuntime, unwrap, expectRejected } from "./helpers";
import { pickRule, normalizeWith, RULES } from "../server/features/integrate/normalize";
import { overlapRate } from "../server/features/integrate/overlap";
import { applyVerdict } from "../server/features/integrate/applyVerdict";
import { Verdict, type PairAdvice } from "../server/schema/verdict";
import { listCandidates } from "../server/features/integrate/candidates";
import { proposePair } from "../server/features/integrate/advise";
import { computeOverlap } from "../server/features/integrate/overlap";
import { decide } from "../server/features/integrate/decide";
import { EngineReject } from "../server/errors";
import { freshDriver } from "../server/infra/fixture";
import { freshMetaStore } from "../server/meta/store";
import { configSchema, type OntologyConfig } from "../server/schema/config";
import { validateSemantics } from "../server/features/ontology/validate";
import { load } from "js-yaml";
import { readFileSync } from "node:fs";

const seedConfig = () => configSchema.parse(load(readFileSync(join(process.cwd(), "src/server/config/ontology.yaml"), "utf8")));

/** 裁决产物必须能过发布闸（结构 + 语义），否则草稿发布不出去。 */
function assertPublishable(d: OntologyConfig) {
  validateSemantics(configSchema.parse(structuredClone(d)));
}

describe("语义校验（validateSemantics）", () => {
  it("when 派生：顶层键必须映射在该源条目上；$link 关系名必须可解析；嵌套键按目标类校", () => {
    const base = seedConfig();
    // 顶层键未映射：status 的派生规则在 device 源条目上过滤了它不映射的属性 ghost
    const bad1 = structuredClone(base);
    bad1.object_types.equipment.properties.status = {
      type: "enum",
      derived: [{ when: { device: { ghost: "x" } }, value: "in_transit" }],
    };
    expect(() => validateSemantics(bad1)).toThrow(/未映射的字段 ghost/);
    // $link 引用了不存在的关系
    const bad2 = structuredClone(base);
    bad2.object_types.equipment.properties.status = {
      type: "enum",
      derived: [{ when: { device: { $link: { ghost_rel: { name: "x" } } } }, value: "in_transit" }],
    };
    expect(() => validateSemantics(bad2)).toThrow(/不存在的关系 ghost_rel/);
    // 嵌套键按目标类校：belongs_to 的目标 department 上没有 ghost 属性
    const bad3 = structuredClone(base);
    bad3.object_types.equipment.properties.status = {
      type: "enum",
      derived: [{ when: { device: { $link: { belongs_to: { ghost: "x" } } } }, value: "in_transit" }],
    };
    expect(() => validateSemantics(bad3)).toThrow(/department 上不存在的字段 ghost/);
    // 合法形状放行：status 现状（含 $link 转化）+ in_warranty 布尔派生
    expect(() => validateSemantics(structuredClone(base))).not.toThrow();
  });

  it("class_conclusions 点到不存在的类则拒", () => {
    const bad = seedConfig();
    bad.class_conclusions = [{ kind: "homonym", classes: ["equipment", "ghost"] }];
    expect(() => validateSemantics(bad)).toThrow(/不存在的类 ghost/);
  });
});

describe("归一化", () => {
  it("序列号：去横杠统一大写；手机号：去 +86 与分隔符；身份证 X 大写", () => {
    const serial = pickRule(["SN-40217", "SN-40080", "SN-40081"]);
    expect(serial.name).toBe("serial");
    expect(normalizeWith(serial, "sn-40217")).toBe("SN40217");
    const phone = pickRule(["+86 138-0000-1111", "13800001111", "+86 139-0000-2222"]);
    expect(phone.name).toBe("phone");
    expect(normalizeWith(phone, "+86 138-0000-1111")).toBe("13800001111");
    const idc = RULES.find((r) => r.name === "id_card")!;
    expect(normalizeWith(idc, "11010119800101123x")).toBe("11010119800101123X");
    expect(pickRule(["随便什么"]).name).toBe("plain");
  });
});

describe("交集率", () => {
  it("采购×设备：40 台重合 / max(121,100) ≈ 三分之一；只落计数", async () => {
    const meta = freshMetaStore(join(mkdtempSync(join(tmpdir(), "ontos-olap-")), "m.db"));
    // 两个视角的类：采购侧的 po_item、设备侧的 device
    const poItem: OntologyConfig["object_types"][string] = {
      kind: "thing",
      identity: "sn",
      properties: { sn: { type: "string" }, name: { type: "string" } },
      sources: { purchase: { connection: "purchase_sys", table: "po_item", pk: "po_id", fields: { sn: "sn", name: "item_name" } } },
    };
    const a = { name: "purchase_item", def: poItem };
    const b = { name: "device_view", def: {
      kind: "thing" as const,
      identity: "serial_no",
      properties: { serial_no: { type: "string" as const } },
      sources: { device: { connection: "device_sys", table: "device", pk: "dev_id", fields: { serial_no: "serial_no" } } },
    } };
    const result = await overlapRate(freshDriver(), a, b, meta);
    expect(result.count_a).toBe(121);
    expect(result.count_b).toBe(100);
    expect(result.count_hit).toBe(40);
    expect(result.rate).toBeCloseTo(40 / 121, 2);
    // 「只落计数」读回验证：adj_overlap 有且仅有计数列，没有值集合
    const rows = await meta.listOverlaps("default");
    expect(rows.length).toBe(1);
    expect(rows[0]).toMatchObject({ class_a: "purchase_item", class_b: "device_view", count_a: 121, count_b: 100, count_hit: 40 });
    expect(Object.keys(rows[0]).every((k) => !/value|set|ids/i.test(k))).toBe(true);
    await meta.close();
  });
});

describe("裁决写草稿", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await setupRuntime("ontos-adj-");
  });
  afterEach(async () => {
    await cleanupRuntime(tmp);
  });

  function twoClasses(): OntologyConfig {
    const d = seedConfig();
    d.object_types.po_a = {
      kind: "thing",
      identity: "sn",
      properties: { sn: { type: "string" }, name: { type: "string" }, extra_a: { type: "string" } },
      sources: { sa: { connection: "purchase_sys", table: "po_item", pk: "po_id", fields: { sn: "sn", name: "item_name" } } },
    };
    d.object_types.po_b = {
      kind: "thing",
      identity: "sn",
      properties: { sn: { type: "string" }, name: { type: "string" }, extra_b: { type: "string" } },
      sources: { sb: { connection: "device_sys", table: "device", pk: "dev_id", fields: { sn: "serial_no", name: "name" } } },
    };
    return d;
  }

  it("类等价：B 的源并进 A，同名对上、特有列加成属性，B 撤掉", () => {
    const d = twoClasses();
    applyVerdict(d, { class_a: "po_a", class_b: "po_b" }, Verdict.Same);
    expect(d.object_types.po_b).toBeUndefined();
    expect(Object.keys(d.object_types.po_a.sources!)).toEqual(["sa", "sb"]);
    expect(d.object_types.po_a.sources!.sb.fields.sn).toBe("serial_no"); // 同名属性对上 B 的列
    expect(d.object_types.po_a.properties.extra_b).toBeDefined(); // 特有列加成属性
    assertPublishable(d);
  });

  it("类等价：识别字段不同名时，B 源条目的 fields 键改写为 A 的识别属性", () => {
    const d = twoClasses();
    d.object_types.po_b.identity = "serial_no";
    d.object_types.po_b.properties = { serial_no: { type: "string" }, name: { type: "string" }, extra_b: { type: "string" } };
    d.object_types.po_b.sources!.sb.fields = { serial_no: "serial_no", name: "name" };
    applyVerdict(d, { class_a: "po_a", class_b: "po_b" }, Verdict.Same);
    const A = d.object_types.po_a;
    expect(A.properties.serial_no).toBeUndefined(); // B 的识别属性不另立
    expect(A.sources!.sb.fields.sn).toBe("serial_no"); // 列映射改写为 A 的识别属性
    expect(A.sources!.sb.fields.serial_no).toBeUndefined();
    assertPublishable(d);
  });

  it("生命周期：收成一类 + 派生 status + transition 关系 + 转化动作", () => {
    const d = twoClasses();
    applyVerdict(d, { class_a: "po_a", class_b: "po_b" }, Verdict.Stage, { from: "在途", to: "在役" });
    const A = d.object_types.po_a;
    expect(d.object_types.po_b).toBeUndefined();
    expect(Object.keys(A.sources!)).toEqual(["sa", "sb"]);
    expect(A.properties.status.derived).toBeDefined();
    const link = d.link_types["po_a_to_在役"];
    expect(link.transition).toEqual({ property: "status", from: "在途", to: "在役" });
    expect(A.actions!.convert_to_在役.effect).toEqual([{ link: "po_a_to_在役" }]);
    assertPublishable(d);
  });

  it("生命周期：B 有特有属性与映射列时也成立（属性并入、字段不悬空）", () => {
    const d = twoClasses();
    d.object_types.po_b.properties.extra_b2 = { type: "string" };
    d.object_types.po_b.sources!.sb.fields.extra_b2 = "name"; // B 特有列也映射着
    applyVerdict(d, { class_a: "po_a", class_b: "po_b" }, Verdict.Stage, { from: "在途", to: "在役" });
    expect(d.object_types.po_a.properties.extra_b2).toBeDefined();
    assertPublishable(d);
  });

  it("部分重叠：公共属性立上位对象并移走，识别字段复制不移动", () => {
    const d = twoClasses();
    applyVerdict(d, { class_a: "po_a", class_b: "po_b" }, Verdict.Overlap);
    const parent = d.object_types.shared_po_a_po_b;
    expect(parent).toBeDefined();
    expect(Object.keys(parent.properties).sort()).toEqual(["name", "sn"]);
    expect(d.object_types.po_a.properties.sn).toBeDefined(); // 识别字段留在原类
    expect(d.object_types.po_a.properties.name).toBeUndefined(); // 公共属性移上去
    expect(d.object_types.po_a.properties.extra_a).toBeDefined(); // 特有留下
    expect(parent.sources!.sa.fields).toEqual({ sn: "sn", name: "item_name" });
    expect(d.class_conclusions).toEqual([{ kind: "overlap", classes: ["po_a", "po_b"], shared: "shared_po_a_po_b" }]);
    assertPublishable(d);
  });

  it("部分重叠：识别字段不同名时，各侧源条目显式带 key", () => {
    const d = twoClasses();
    d.object_types.po_b.identity = "serial_no";
    d.object_types.po_b.properties = { serial_no: { type: "string" }, name: { type: "string" }, extra_b: { type: "string" } };
    d.object_types.po_b.sources!.sb.fields = { serial_no: "serial_no", name: "name" };
    applyVerdict(d, { class_a: "po_a", class_b: "po_b" }, Verdict.Overlap);
    const parent = d.object_types.shared_po_a_po_b;
    expect(parent.sources!.sa.key).toBe("sn");
    expect(parent.sources!.sb.key).toBe("serial_no");
    assertPublishable(d);
  });

  it("部分重叠：没有同名公共字段仍立公共对象，只带唯一键", () => {
    const d = twoClasses();
    d.object_types.po_b.identity = "serial_no";
    d.object_types.po_b.properties = { serial_no: { type: "string" }, extra_b: { type: "string" } };
    d.object_types.po_b.sources!.sb.fields = { serial_no: "serial_no", extra_b: "name" };
    applyVerdict(d, { class_a: "po_a", class_b: "po_b" }, Verdict.Overlap);
    const parent = d.object_types.shared_po_a_po_b;
    expect(parent).toBeDefined();
    expect(parent.properties.name).toBeUndefined(); // 没有同名公共字段，不上移
    expect(parent.properties.sn).toBeDefined(); // 唯一键复制上去
    expect(parent.properties.serial_no).toBeDefined();
    expect(d.object_types.po_a.properties.extra_a).toBeDefined();
    expect(d.object_types.po_b.properties.extra_b).toBeDefined();
    assertPublishable(d);
  });

  it("同形异义：两类留下，写入 class_conclusions；classes 按名字排序", () => {
    const d = twoClasses();
    applyVerdict(d, { class_a: "po_b", class_b: "po_a" }, Verdict.NameSimilar);
    expect(d.object_types.po_a).toBeDefined();
    expect(d.object_types.po_b).toBeDefined();
    expect(d.class_conclusions).toEqual([{ kind: "homonym", classes: ["po_a", "po_b"] }]);
    assertPublishable(d);
  });

  it("跳过：配置不动", () => {
    const d = twoClasses();
    const before = JSON.stringify(d);
    applyVerdict(d, { class_a: "po_a", class_b: "po_b" }, Verdict.Skip);
    expect(JSON.stringify(d)).toBe(before);
  });

  it("并掉类时撤掉点到它的 class_conclusions", () => {
    const d = twoClasses();
    applyVerdict(d, { class_a: "po_a", class_b: "po_b" }, Verdict.NameSimilar);
    applyVerdict(d, { class_a: "po_a", class_b: "po_b" }, Verdict.Same);
    expect(d.object_types.po_b).toBeUndefined();
    expect(d.class_conclusions ?? []).toEqual([]);
  });
});

describe("裁决流水线", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await setupRuntime("ontos-pairs-");
  });
  afterEach(async () => {
    await cleanupRuntime(tmp);
  });

  it("decide「同一」：合并两个跨源类，留痕带证据", async () => {
    const s = await draftEngine();
    await s.editDraft({
      op: "import_objects",
      objects: {
        po_a: { kind: "thing", identity: "sn", properties: { sn: { type: "string" } }, sources: { sa: { connection: "purchase_sys", table: "po_item", pk: "po_id", fields: { sn: "sn" } } } },
        po_b: { kind: "thing", identity: "serial_no", properties: { serial_no: { type: "string" } }, sources: { sb: { connection: "device_sys", table: "device", pk: "dev_id", fields: { serial_no: "serial_no" } } } },
      },
    });
    const r = unwrap(await decide(s.env, {
      class_a: "po_a",
      class_b: "po_b",
      verdict: Verdict.Same,
      evidence: { norm_rule: "serial", count_a: 121, count_b: 100, count_hit: 40, rate: 0.33 },
    }));
    expect(r).toEqual({ ok: true, recorded: true });
    const d = (await s.getDraft()).draft;
    expect(d.object_types.po_b).toBeUndefined();
    expect(d.object_types.po_a.sources!.sb.fields.sn).toBe("serial_no");
    const meta = (await import("../server/meta/store")).metaStore();
    const dec = (await meta.listDecisions("default"))[0];
    expect(dec.verdict).toBe(Verdict.Same);
    expect(dec.evidence?.count_hit).toBe(40);
    expect(dec.version).toBeNull();
    await s.publish();
    expect((await meta.listDecisions("default"))[0].version).toBe(1); // default 首发布即 v1（注册不产生已发布版本）
  });

  it("decide：校验闸回退时不留幻影记录", async () => {
    const s = await draftEngine();
    await s.editDraft({
      op: "import_objects",
      objects: {
        po_a: { kind: "thing", identity: "sn", properties: { sn: { type: "string" }, status: { type: "string" } }, sources: { sa: { connection: "purchase_sys", table: "po_item", pk: "po_id", fields: { sn: "sn", status: "sn" } } } },
        po_b: { kind: "thing", identity: "sn", properties: { sn: { type: "string" } }, sources: { sb: { connection: "device_sys", table: "device", pk: "dev_id", fields: { sn: "serial_no" } } } },
      },
    });
    await expectRejected(decide(s.env, { class_a: "po_a", class_b: "po_b", verdict: Verdict.Stage, stage_names: { from: "在途", to: "在役" } }));
    const meta = (await import("../server/meta/store")).metaStore();
    expect((await meta.listDecisions("default")).length).toBe(0);
    expect((await s.getDraft()).draft.object_types.po_b).toBeDefined();
  });

  it("listCandidates：槽位把同一对写两遍或对调两端，只出一条", async () => {
    const s = await draftEngine();
    await s.editDraft({
      op: "import_objects",
      objects: {
        po_a: { kind: "thing", identity: "sn", properties: { sn: { type: "string" }, name: { type: "string" } }, sources: { sa: { connection: "purchase_sys", table: "po_item", pk: "po_id", fields: { sn: "sn", name: "item_name" } } } },
        po_b: { kind: "thing", identity: "sn", properties: { sn: { type: "string" }, name: { type: "string" } }, sources: { sb: { connection: "device_sys", table: "device", pk: "dev_id", fields: { sn: "serial_no", name: "name" } } } },
      },
    });
    const one: { class_a: string; class_b: string; tendency: Verdict.Same; reason: string } = {
      class_a: "po_a",
      class_b: "po_b",
      tendency: Verdict.Same,
      reason: "字段重合",
    };
    const list = unwrap(
      await listCandidates({
        ...s.env,
        llm: {
          name: "dup",
          nlToQuery: async () => ({ object: "po_a" }),
          proposeObjects: async () => ({}),
          proposePairs: async () => [one, one, { ...one, class_a: "po_b", class_b: "po_a" }],
          proposePair: async () => one,
        },
      })
    );
    const isPair = (p: { class_a: string; class_b: string }) =>
      (p.class_a === "po_a" && p.class_b === "po_b") || (p.class_a === "po_b" && p.class_b === "po_a");
    expect(list.filter(isPair)).toHaveLength(1);
  });

  it("候选快照：同一草稿只问一次模型；投喂形状变了才重算；定案读时过滤", async () => {
    const s = await draftEngine();
    await s.editDraft({
      op: "import_objects",
      objects: {
        po_a: { kind: "thing", identity: "sn", properties: { sn: { type: "string" }, name: { type: "string" } }, sources: { sa: { connection: "purchase_sys", table: "po_item", pk: "po_id", fields: { sn: "sn", name: "item_name" } } } },
        po_b: { kind: "thing", identity: "sn", properties: { sn: { type: "string" }, name: { type: "string" } }, sources: { sb: { connection: "device_sys", table: "device", pk: "dev_id", fields: { sn: "serial_no", name: "name" } } } },
      },
    });
    let calls = 0;
    const one: { class_a: string; class_b: string; tendency: Verdict.Same; reason: string } = {
      class_a: "po_a",
      class_b: "po_b",
      tendency: Verdict.Same,
      reason: "字段重合",
    };
    const env = {
      ...s.env,
      llm: {
        name: "count",
        nlToQuery: async () => ({ object: "po_a" }),
        proposeObjects: async () => ({}),
        proposePairs: async () => {
          calls++;
          return [one];
        },
        proposePair: async () => one,
      },
    };
    const isPair = (p: { class_a: string; class_b: string }) =>
      (p.class_a === "po_a" && p.class_b === "po_b") || (p.class_a === "po_b" && p.class_b === "po_a");
    expect(unwrap(await listCandidates(env)).some(isPair)).toBe(true);
    expect(unwrap(await listCandidates(env)).some(isPair)).toBe(true);
    expect(calls).toBe(1); // 第二次读的是快照，没再问模型
    await s.editDraft({ op: "set_identity", object: "po_a", name: "name" }); // 唯一键不在投喂形状里
    unwrap(await listCandidates(env));
    expect(calls).toBe(1);
    await s.editDraft({ op: "save_layout", positions: { po_a: { x: 1, y: 2 } } }); // 摆位也不在
    unwrap(await listCandidates(env));
    expect(calls).toBe(1);
    await s.editDraft({ op: "add_property", object: "po_a", name: "extra", type: "string" }); // 字段变 = 形状变
    unwrap(await listCandidates(env));
    expect(calls).toBe(2); // 重算一次
    unwrap(await decide(env, { class_a: "po_a", class_b: "po_b", verdict: Verdict.Skip }));
    expect(unwrap(await listCandidates(env)).some(isPair)).toBe(false); // 定案读时过滤，跳过立即不见
    expect(calls).toBe(2); // 不问模型
    await env.meta.abandonPendingDecisions("default"); // 放弃草稿：未绑版本的裁决作废
    expect(unwrap(await listCandidates(env)).some(isPair)).toBe(true); // 对回来了
    expect(calls).toBe(2); // 草稿内容没变，仍不重算
  });

  it("decide「跳过」：不动草稿但留痕；listCandidates 不再列出", async () => {
    const s = await draftEngine();
    await s.editDraft({
      op: "import_objects",
      objects: {
        po_a: { kind: "thing", identity: "sn", properties: { sn: { type: "string" }, name: { type: "string" } }, sources: { sa: { connection: "purchase_sys", table: "po_item", pk: "po_id", fields: { sn: "sn", name: "item_name" } } } },
        po_b: { kind: "thing", identity: "sn", properties: { sn: { type: "string" }, name: { type: "string" } }, sources: { sb: { connection: "device_sys", table: "device", pk: "dev_id", fields: { sn: "serial_no", name: "name" } } } },
      },
    });
    const isPair = (p: { class_a: string; class_b: string }) =>
      (p.class_a === "po_a" && p.class_b === "po_b") || (p.class_a === "po_b" && p.class_b === "po_a");
    expect(unwrap(await listCandidates(s.env)).some(isPair)).toBe(true);
    const before = JSON.stringify((await s.getDraft()).draft);
    const r = unwrap(await decide(s.env, { class_a: "po_a", class_b: "po_b", verdict: Verdict.Skip }));
    expect(r.recorded).toBe(true);
    expect(JSON.stringify((await s.getDraft()).draft)).toBe(before);
    expect(unwrap(await listCandidates(s.env)).some(isPair)).toBe(false);
  });

  it("proposePair：看过交集率后改口；空表不因 0% 改口；无源拒绝；同一库两张表可以建议", async () => {
    const s = await draftEngine();
    await s.editDraft({
      op: "import_objects",
      objects: {
        po_a: { kind: "thing", identity: "sn", properties: { sn: { type: "string" }, name: { type: "string" } }, sources: { sa: { connection: "purchase_sys", table: "po_item", pk: "po_id", fields: { sn: "sn", name: "item_name" } } } },
        po_b: { kind: "thing", identity: "sn", properties: { sn: { type: "string" }, name: { type: "string" } }, sources: { sb: { connection: "device_sys", table: "device", pk: "dev_id", fields: { sn: "serial_no", name: "name" } } } },
      },
    });
    const miss = unwrap(await proposePair(s.env, "default", "po_a", "po_b", { rate: 0, count_a: 100, count_b: 80, count_hit: 0 }));
    expect(miss.tendency).toBe(Verdict.Same); // 不是同一批，但不能据此否定同一
    const empty = unwrap(await proposePair(s.env, "default", "po_a", "po_b", { rate: 0, count_a: 100, count_b: 0, count_hit: 0 }));
    expect(empty.tendency).toBe(Verdict.Same);
    await s.editDraft({ op: "create_object", name: "vendor", kind: "thing" });
    expect((await proposePair(s.env, "default", "po_a", "vendor", { rate: 0, count_a: 1, count_b: 1, count_hit: 0 })).code).toBe(422);
    await s.editDraft({
      op: "import_objects",
      objects: {
        asg: { kind: "thing", identity: "sn", properties: { sn: { type: "string" } }, sources: { sc: { connection: "device_sys", table: "assignment", pk: "id", fields: { sn: "sn" } } } },
      },
    });
    expect((await proposePair(s.env, "default", "po_b", "asg", { rate: 0.5, count_a: 2, count_b: 2, count_hit: 1 })).code).toBe(200); // 同一库两张表也可以建议
  });

  it("proposePair：清单快照里的第一版建议作为锚传给槽位", async () => {
    const s = await draftEngine();
    await s.editDraft({
      op: "import_objects",
      objects: {
        po_a: { kind: "thing", identity: "sn", properties: { sn: { type: "string" }, name: { type: "string" } }, sources: { sa: { connection: "purchase_sys", table: "po_item", pk: "po_id", fields: { sn: "sn", name: "item_name" } } } },
        po_b: { kind: "thing", identity: "sn", properties: { sn: { type: "string" }, name: { type: "string" } }, sources: { sb: { connection: "device_sys", table: "device", pk: "dev_id", fields: { sn: "serial_no", name: "name" } } } },
      },
    });
    const one: { class_a: string; class_b: string; tendency: Verdict.Overlap; reason: string } = {
      class_a: "po_a",
      class_b: "po_b",
      tendency: Verdict.Overlap,
      reason: "字段部分重合",
    };
    let seenBase: unknown;
    const env = {
      ...s.env,
      llm: {
        name: "anchor",
        nlToQuery: async () => ({ object: "po_a" }),
        proposeObjects: async () => ({}),
        proposePairs: async () => [one], // 第一版建议（进快照）
        proposePair: async (input: { base?: { tendency: Verdict; reason: string } }) => {
          seenBase = input.base;
          return { class_a: "po_a", class_b: "po_b", tendency: Verdict.Overlap as const, reason: "维持" };
        },
      },
    };
    unwrap(await proposePair(env, "default", "po_a", "po_b", { rate: 0, count_a: 100, count_b: 0, count_hit: 0 }));
    expect(seenBase).toEqual({ tendency: Verdict.Overlap, reason: "字段部分重合" }); // 第二版的锚 = 快照里的第一版
  });

  it("computeOverlap：无源类拒绝；同一库两张表可以算", async () => {
    const s = await draftEngine();
    await s.editDraft({ op: "create_object", name: "vendor", kind: "thing" }, "test");
    expect((await computeOverlap(s.env, "test", "repair", "vendor")).code).toBe(422);
    expect((await computeOverlap(s.env, "test", "repair", "assignment")).code).toBe(200);
  });

  it("同一库两张表：listCandidates 收进；「同一」合并后两个源条目都留下", async () => {
    const s = await draftEngine();
    await s.editDraft({
      op: "import_objects",
      objects: {
        dev: {
          kind: "thing",
          identity: "sn",
          properties: { sn: { type: "string" }, name: { type: "string" } },
          sources: { device_sys: { connection: "device_sys", table: "device", pk: "dev_id", fields: { sn: "serial_no", name: "name" } } },
        },
        asg: {
          kind: "thing",
          identity: "sn",
          properties: { sn: { type: "string" }, name: { type: "string" } },
          sources: { device_sys: { connection: "device_sys", table: "assignment", pk: "id", fields: { sn: "sn", name: "asgn_no" } } },
        },
      },
    });
    const isPair = (p: { class_a: string; class_b: string }) =>
      (p.class_a === "dev" && p.class_b === "asg") || (p.class_a === "asg" && p.class_b === "dev");
    expect(unwrap(await listCandidates(s.env)).some(isPair)).toBe(true);
    unwrap(await decide(s.env, { class_a: "dev", class_b: "asg", verdict: Verdict.Same }));
    const d = (await s.getDraft()).draft;
    expect(d.object_types.asg).toBeUndefined();
    expect(d.object_types.dev.sources!.device_sys.table).toBe("device");
    expect(d.object_types.dev.sources!.device_sys_asg.table).toBe("assignment");
    assertPublishable(d);
  });

  const pairOf = (x: string, y: string) => (p: { class_a: string; class_b: string }) =>
    (p.class_a === x && p.class_b === y) || (p.class_a === y && p.class_b === x);

  const stubLlm = (proposePairs: () => PairAdvice[]) => ({
    name: "chain",
    nlToQuery: async () => ({ object: "a" }),
    proposeObjects: async () => ({}),
    proposePairs: async () => proposePairs(),
    proposePair: async () => proposePairs()[0] ?? { class_a: "a", class_b: "b", tendency: Verdict.Same as const, reason: "" },
  });

  const threeSourced = {
    a: { kind: "thing" as const, identity: "sn", properties: { sn: { type: "string" as const }, name: { type: "string" as const } }, sources: { sa: { connection: "purchase_sys", table: "po_item", pk: "po_id", fields: { sn: "sn", name: "item_name" } } } },
    b: { kind: "thing" as const, identity: "sn", properties: { sn: { type: "string" as const }, name: { type: "string" as const } }, sources: { sb: { connection: "device_sys", table: "device", pk: "dev_id", fields: { sn: "serial_no", name: "name" } } } },
    c: { kind: "thing" as const, identity: "sn", properties: { sn: { type: "string" as const }, name: { type: "string" as const } }, sources: { sc: { connection: "asset_sys", table: "asset", pk: "asset_id", fields: { sn: "sn", name: "asset_name" } } } },
    d: { kind: "thing" as const, identity: "sn", properties: { sn: { type: "string" as const }, name: { type: "string" as const } }, sources: { sd: { connection: "hr_sys", table: "person", pk: "person_no", fields: { sn: "person_no", name: "name" } } } },
  };

  it("疑似重复串：「同一」之后 B–C 改问 A–C；串外的 D 不进来；不再问模型", async () => {
    const s = await draftEngine();
    await s.editDraft({ op: "import_objects", objects: threeSourced });
    let calls = 0;
    const env = {
      ...s.env,
      llm: stubLlm(() => {
        calls++;
        return [
          { class_a: "a", class_b: "b", tendency: Verdict.Same, reason: "1", keep: "a" },
          { class_a: "b", class_b: "c", tendency: Verdict.Stage, reason: "2", keep: "c", stage: { earlier: "b", from: "in_transit", to: "in_service" } },
        ];
      }),
    };
    expect(unwrap(await listCandidates(env)).map((p) => `${p.class_a}-${p.class_b}`).sort()).toEqual(["a-b", "b-c"]);
    expect(calls).toBe(1);
    unwrap(await decide(env, { class_a: "a", class_b: "b", verdict: Verdict.Same }));
    const left = unwrap(await listCandidates(env));
    expect(left.some(pairOf("a", "c"))).toBe(true);
    expect(left.some(pairOf("a", "b"))).toBe(false);
    expect(left.some(pairOf("b", "c"))).toBe(false);
    expect(left.some(pairOf("a", "d"))).toBe(false);
    expect(calls).toBe(1);
    const ac = left.find(pairOf("a", "c"));
    expect(ac?.pending).toBe(true);
    expect(ac?.reason).toContain("还该问");
    expect(ac?.reason).not.toBe("2");
    expect(ac?.keep).toBe("c"); // 原 keep=c，并掉 b 之后还是 c
    expect(ac?.stage?.earlier).toBe("a"); // 原 earlier=b，b 并进 a
  });

  it("疑似重复串：「阶段」之后 B–C 改问 A–C；不再问模型", async () => {
    const s = await draftEngine();
    await s.editDraft({ op: "import_objects", objects: { a: threeSourced.a, b: threeSourced.b, c: threeSourced.c } });
    let calls = 0;
    const env = {
      ...s.env,
      llm: stubLlm(() => {
        calls++;
        return [
          { class_a: "a", class_b: "b", tendency: Verdict.Stage, reason: "1" },
          { class_a: "b", class_b: "c", tendency: Verdict.Overlap, reason: "2" },
        ];
      }),
    };
    unwrap(await listCandidates(env));
    unwrap(await decide(env, { class_a: "a", class_b: "b", verdict: Verdict.Stage, stage_names: { from: "in_transit", to: "in_service" } }));
    const left = unwrap(await listCandidates(env));
    expect(left.some(pairOf("a", "c"))).toBe(true);
    expect(left.some(pairOf("b", "c"))).toBe(false);
    expect(calls).toBe(1);
  });

  it("疑似重复串：钉快照失败也不把串外的 D 拉进来", async () => {
    const s = await draftEngine();
    await s.editDraft({ op: "import_objects", objects: threeSourced });
    let calls = 0;
    let writes = 0;
    const env = {
      ...s.env,
      llm: stubLlm(() => {
        calls++;
        return [
          { class_a: "a", class_b: "b", tendency: Verdict.Same, reason: "1" },
          { class_a: "b", class_b: "c", tendency: Verdict.Overlap, reason: "2" },
        ];
      }),
    };
    const origWrite = env.meta.writeCandidateSnapshot.bind(env.meta);
    env.meta.writeCandidateSnapshot = async (workspace, snap) => {
      writes++;
      if (writes > 1) throw new Error("pin fail");
      return origWrite(workspace, snap);
    };
    unwrap(await listCandidates(env));
    expect(calls).toBe(1);
    unwrap(await decide(env, { class_a: "a", class_b: "b", verdict: Verdict.Same }));
    const left = unwrap(await listCandidates(env));
    expect(left.some(pairOf("a", "d"))).toBe(false);
    expect(calls).toBe(1);
  });

  it("疑似重复串：「部分重叠」之后 B–C 还在；公共对象不跟串里每个类成对；不再问模型", async () => {
    const s = await draftEngine();
    await s.editDraft({ op: "import_objects", objects: { a: threeSourced.a, b: threeSourced.b, c: threeSourced.c } });
    let calls = 0;
    const env = {
      ...s.env,
      llm: stubLlm(() => {
        calls++;
        return [
          { class_a: "a", class_b: "b", tendency: Verdict.Overlap, reason: "1" },
          { class_a: "b", class_b: "c", tendency: Verdict.Same, reason: "2" },
        ];
      }),
    };
    unwrap(await listCandidates(env));
    expect(calls).toBe(1);
    unwrap(await decide(env, { class_a: "a", class_b: "b", verdict: Verdict.Overlap }));
    const left = unwrap(await listCandidates(env));
    expect(left.some(pairOf("a", "b"))).toBe(false);
    expect(left.some(pairOf("b", "c"))).toBe(true);
    expect(left.some((p) => p.class_a.startsWith("shared_") || p.class_b.startsWith("shared_"))).toBe(false);
    expect(calls).toBe(1);
  });

  it("疑似重复串：A–C 已跳过，「同一」把 B 并进 A 后不重开 A–C", async () => {
    const s = await draftEngine();
    await s.editDraft({ op: "import_objects", objects: { a: threeSourced.a, b: threeSourced.b, c: threeSourced.c } });
    const env = {
      ...s.env,
      llm: stubLlm(() => [
        { class_a: "a", class_b: "b", tendency: Verdict.Same, reason: "1" },
        { class_a: "b", class_b: "c", tendency: Verdict.Same, reason: "2" },
        { class_a: "a", class_b: "c", tendency: Verdict.NameSimilar, reason: "3" },
      ]),
    };
    unwrap(await listCandidates(env));
    unwrap(await decide(env, { class_a: "a", class_b: "c", verdict: Verdict.Skip }));
    unwrap(await decide(env, { class_a: "a", class_b: "b", verdict: Verdict.Same }));
    const left = unwrap(await listCandidates(env));
    expect(left.some(pairOf("a", "c"))).toBe(false);
    expect(left.some(pairOf("a", "b"))).toBe(false);
  });

  it("疑似重复串：先跳过 B–C，再把 B 并进 A，不把已拿掉的牵线改写成 A–C", async () => {
    const s = await draftEngine();
    await s.editDraft({ op: "import_objects", objects: { a: threeSourced.a, b: threeSourced.b, c: threeSourced.c } });
    let calls = 0;
    const env = {
      ...s.env,
      llm: stubLlm(() => {
        calls++;
        return [
          { class_a: "a", class_b: "b", tendency: Verdict.Same, reason: "1" },
          { class_a: "b", class_b: "c", tendency: Verdict.Same, reason: "2" },
        ];
      }),
    };
    unwrap(await listCandidates(env));
    unwrap(await decide(env, { class_a: "b", class_b: "c", verdict: Verdict.Skip }));
    unwrap(await decide(env, { class_a: "a", class_b: "b", verdict: Verdict.Same }));
    const left = unwrap(await listCandidates(env));
    expect(left.some(pairOf("a", "c"))).toBe(false);
    expect(calls).toBe(1);
  });
});
