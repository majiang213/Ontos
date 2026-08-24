// M3 测试：归一化、交集率（真实读源计算）、裁决写草稿的四种结论。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupRuntime, setupRuntime } from "./helpers";
import { pickRule, normalizeWith, RULES } from "../server/engine/adjudication/normalize";
import { overlapRate } from "../server/engine/adjudication/overlap";
import { applyVerdict } from "../server/engine/adjudication/adjudicate";
import { Verdict } from "../server/engine/adjudication/verdict";
import { decide, listCandidates, computeOverlap } from "../server/engine/adjudication/pairs";
import { EngineReject } from "../server/errors";
import { freshDriver } from "../server/engine/infra/load";
import { freshMetaStore } from "../server/meta/store";
import { configSchema, type OntologyConfig } from "../server/schema/config";
import { validateSemantics } from "../server/engine/config/validate";
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
    expect(() => validateSemantics(bad1)).toThrow(/未映射的属性 ghost/);
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
    expect(() => validateSemantics(bad3)).toThrow(/department 上不存在的属性 ghost/);
    // 合法形状放行：status 现状（含 $link 转化）+ in_warranty 布尔派生
    expect(() => validateSemantics(structuredClone(base))).not.toThrow();
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

  it("同一：B 的源并进 A，同名对上、特有列加成属性，B 撤掉", () => {
    const d = twoClasses();
    applyVerdict(d, { class_a: "po_a", class_b: "po_b" }, Verdict.Same);
    expect(d.object_types.po_b).toBeUndefined();
    expect(Object.keys(d.object_types.po_a.sources!)).toEqual(["sa", "sb"]);
    expect(d.object_types.po_a.sources!.sb.fields.sn).toBe("serial_no"); // 同名属性对上 B 的列
    expect(d.object_types.po_a.properties.extra_b).toBeDefined(); // 特有列加成属性
    assertPublishable(d);
  });

  it("同一：识别字段不同名时，B 源条目的 fields 键改写为 A 的识别属性", () => {
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

  it("阶段：收成一类 + 派生 status + transition 关系 + 转化动作", () => {
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

  it("阶段：B 有特有属性与映射列时也成立（属性并入、字段不悬空）", () => {
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

  it("仅名称相似：配置不动", () => {
    const d = twoClasses();
    const before = JSON.stringify(d);
    applyVerdict(d, { class_a: "po_a", class_b: "po_b" }, Verdict.NameSimilar);
    expect(JSON.stringify(d)).toBe(before);
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
    const s = await import("../server/engine/config/configStore");
    await s.applyDraft({
      op: "import_objects",
      objects: {
        po_a: { kind: "thing", identity: "sn", properties: { sn: { type: "string" } }, sources: { sa: { connection: "purchase_sys", table: "po_item", pk: "po_id", fields: { sn: "sn" } } } },
        po_b: { kind: "thing", identity: "serial_no", properties: { serial_no: { type: "string" } }, sources: { sb: { connection: "device_sys", table: "device", pk: "dev_id", fields: { serial_no: "serial_no" } } } },
      },
    });
    const r = await decide({
      class_a: "po_a",
      class_b: "po_b",
      verdict: Verdict.Same,
      evidence: { norm_rule: "serial", count_a: 121, count_b: 100, count_hit: 40, rate: 0.33 },
    });
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
    expect((await meta.listDecisions("default"))[0].version).toBe(2);
  });

  it("decide：校验闸回退时不留幻影记录", async () => {
    const s = await import("../server/engine/config/configStore");
    await s.applyDraft({
      op: "import_objects",
      objects: {
        po_a: { kind: "thing", identity: "sn", properties: { sn: { type: "string" }, status: { type: "string" } }, sources: { sa: { connection: "purchase_sys", table: "po_item", pk: "po_id", fields: { sn: "sn", status: "sn" } } } },
        po_b: { kind: "thing", identity: "sn", properties: { sn: { type: "string" } }, sources: { sb: { connection: "device_sys", table: "device", pk: "dev_id", fields: { sn: "serial_no" } } } },
      },
    });
    await expect(decide({ class_a: "po_a", class_b: "po_b", verdict: Verdict.Stage, stage_names: { from: "在途", to: "在役" } })).rejects.toThrow();
    const meta = (await import("../server/meta/store")).metaStore();
    expect((await meta.listDecisions("default")).length).toBe(0);
    expect((await s.getDraft()).draft.object_types.po_b).toBeDefined();
  });

  it("decide「跳过」：不动草稿但留痕；listCandidates 不再列出", async () => {
    const s = await import("../server/engine/config/configStore");
    await s.applyDraft({
      op: "import_objects",
      objects: {
        po_a: { kind: "thing", identity: "sn", properties: { sn: { type: "string" }, name: { type: "string" } }, sources: { sa: { connection: "purchase_sys", table: "po_item", pk: "po_id", fields: { sn: "sn", name: "item_name" } } } },
        po_b: { kind: "thing", identity: "sn", properties: { sn: { type: "string" }, name: { type: "string" } }, sources: { sb: { connection: "device_sys", table: "device", pk: "dev_id", fields: { sn: "serial_no", name: "name" } } } },
      },
    });
    const isPair = (p: { class_a: string; class_b: string }) =>
      (p.class_a === "po_a" && p.class_b === "po_b") || (p.class_a === "po_b" && p.class_b === "po_a");
    expect((await listCandidates()).some(isPair)).toBe(true);
    const before = JSON.stringify((await s.getDraft()).draft);
    const r = await decide({ class_a: "po_a", class_b: "po_b", verdict: Verdict.Skip });
    expect(r.recorded).toBe(true);
    expect(JSON.stringify((await s.getDraft()).draft)).toBe(before);
    expect((await listCandidates()).some(isPair)).toBe(false);
  });

  it("computeOverlap：无源类、同源对拒绝", async () => {
    const s = await import("../server/engine/config/configStore");
    await s.applyDraft({ op: "create_object", name: "vendor", kind: "thing" });
    await expect(computeOverlap("default", "equipment", "vendor")).rejects.toThrow(EngineReject);
    await expect(computeOverlap("default", "repair", "assignment")).rejects.toThrow(EngineReject);
  });
});
