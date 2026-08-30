// schema 层契约测试：全平台契约（本体配置、编辑操作、问数/动作请求、过滤树走查）的正反对照例。
// schema 是全平台的单一事实源：什么合法、什么拒绝在这里钉死，不靠路由测试附带覆盖。

import { describe, expect, it } from "vitest";
import { load } from "js-yaml";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { configSchema, enumValueKey, enumValueLabel } from "../server/schema/config";
import { draftOpSchema, mcpDraftOpSchema } from "../server/schema/ops";
import { EXPR_LIKE, FROM_KEY_SET, isFromOnly, isPlainLiteral, propertyRef } from "../server/schema/spec/valueSpec";
import { actionRequestSchema, queryRequestSchema } from "../server/schema/request";
import { walkFilter } from "../server/schema/spec/filterSpec";
import { cleanAdvice, executionPlan, stageValues, Verdict } from "../server/schema/verdict";

describe("configSchema", () => {
  it("种子配置全收（正例骨架）", () => {
    const cfg = configSchema.parse(load(readFileSync(join(process.cwd(), "src/server/config/ontology.yaml"), "utf8")));
    expect(cfg.object_types.equipment).toBeDefined();
  });

  it("枚举值域两种形状：裸字面量与 { value, label }；accessor 取 key 与中文名", () => {
    const cfg = configSchema.parse({
      object_types: {
        a: { kind: "thing", properties: { s: { type: "enum", values: ["x", { value: "y", label: "为何" }, { value: "z" }] } } },
      },
      link_types: {},
    });
    const values = cfg.object_types.a.properties.s.values!;
    expect(values.map((v) => enumValueKey(v))).toEqual(["x", "y", "z"]);
    expect(values.map((v) => enumValueLabel(v))).toEqual([undefined, "为何", undefined]);
  });

  it("关系 match 与 transition 同写或都不写，都拒", () => {
    expect(() => configSchema.parse({ object_types: {}, link_types: { l: { from: "a", to: "b" } } })).toThrow(/必须且只能写一种/);
    expect(() =>
      configSchema.parse({ object_types: {}, link_types: { l: { from: "a", to: "b", match: [{ from: "x", to: "y" }], transition: { property: "s", from: "p", to: "q" } } } })
    ).toThrow(/必须且只能写一种/);
  });
  it("effect update 的 properties 为空被拒（空 SET 不是合法 SQL）", () => {
    const cfg = {
      object_types: { a: { kind: "thing", properties: {}, actions: { act: { effect: [{ update: { object: "a", properties: {} } }] } } } },
    };
    expect(() => configSchema.parse(cfg)).toThrow(/不能为空/);
  });
  it("class_conclusions：部分重叠必须写 shared；同形异义不许写；classes 不得重复", () => {
    const objects = {
      a: { kind: "thing" as const, properties: { n: { type: "string" as const } } },
      b: { kind: "thing" as const, properties: { n: { type: "string" as const } } },
      shared_a_b: { kind: "thing" as const, properties: { n: { type: "string" as const } } },
    };
    expect(() =>
      configSchema.parse({ object_types: objects, class_conclusions: [{ kind: "overlap", classes: ["a", "b"] }] })
    ).toThrow(/必须写 shared/);
    expect(() =>
      configSchema.parse({
        object_types: objects,
        class_conclusions: [{ kind: "homonym", classes: ["a", "b"], shared: "shared_a_b" }],
      })
    ).toThrow(/只有部分重叠能写 shared/);
    expect(() =>
      configSchema.parse({ object_types: objects, class_conclusions: [{ kind: "homonym", classes: ["a", "a"] }] })
    ).toThrow(/有重复的类名/);
    const ok = configSchema.parse({
      object_types: objects,
      class_conclusions: [{ kind: "overlap", classes: ["a", "b"], shared: "shared_a_b" }],
    });
    expect(ok.class_conclusions).toEqual([{ kind: "overlap", classes: ["a", "b"], shared: "shared_a_b" }]);
  });
  it("派生属性进 fields 是语义问题，schema 不抢话（归 validateSemantics）", () => {
    // fields 收任意属性名；派生拦截在引擎语义校验——分层各管一段，这里只钉结构
    const cfg = configSchema.parse({
      object_types: { a: { kind: "thing", properties: { s: { type: "string", derived: { s: "x" } } }, sources: { sa: { connection: "c", table: "t", fields: { s: "col" } } } } },
    });
    expect(cfg.object_types.a.sources!.sa.fields.s).toBe("col");
  });
});

describe("draftOpSchema", () => {
  it("全部操作各收一例（15 内容 + 2 界面状态）", () => {
    const ops: unknown[] = [
      { op: "create_object", name: "vendor", kind: "thing" },
      { op: "delete_object", name: "vendor" },
      { op: "update_object", name: "vendor", description: "供应商" },
      { op: "update_object", name: "vendor", new_name: "supplier" },
      { op: "edit_stages", object: "equipment", items: [{ value: "in_transit", when: { purchase: true } }, { value: "in_service", when: { device: true } }] },
      { op: "add_property", object: "vendor", name: "vendor_no", type: "string" },
      { op: "remove_property", object: "vendor", name: "vendor_no" },
      { op: "update_property", object: "vendor", name: "vendor_no", new_name: "vendor_code", type: "string", description: "供应商编号" },
      { op: "set_identity", object: "vendor", name: "vendor_no" },
      { op: "save_layout", positions: { vendor: { x: 10, y: 20 } } },
      { op: "save_edge_bend", name: "supplies", bend: { dx: 12, dy: -8 } },
      { op: "create_link", name: "supplies", from: "vendor", to: "equipment", match: { from: "vendor_no", to: "vendor_no" } },
      { op: "delete_link", name: "supplies" },
      { op: "update_link", name: "supplies", new_name: "supplied_by", description: "供应关系" },
      { op: "import_objects", objects: { vendor: { kind: "thing", properties: {} } } },
      { op: "replace_object", name: "vendor", def: { kind: "thing", properties: {} } },
      { op: "set_action", object: "vendor", name: "rename", def: { effect: [{ update: { object: "vendor", identity: { from: "identity" }, properties: { vendor_no: { from: "request" } } } }] } },
      { op: "remove_action", object: "vendor", name: "rename" },
    ];
    for (const op of ops) expect(draftOpSchema.parse(op)).toBeTruthy();
  });
  it("未知操作被拒；save_layout 的坐标必须是数值", () => {
    expect(() => draftOpSchema.parse({ op: "fly_to_moon" })).toThrow();
    expect(() => draftOpSchema.parse({ op: "save_layout", positions: { equipment: { x: "10", y: 20 } } })).toThrow();
  });
  it("set_action 的 def 必须过 actionSchema：缺 effect、效应形状不合法都拒", () => {
    expect(() => draftOpSchema.parse({ op: "set_action", object: "vendor", name: "a", def: { description: "没效应" } })).toThrow();
    expect(() => draftOpSchema.parse({ op: "set_action", object: "vendor", name: "a", def: { effect: [] } })).toThrow(); // effect 非空
    expect(() => draftOpSchema.parse({ op: "set_action", object: "vendor", name: "a", def: { effect: [{ update: { object: "vendor", properties: {} } }] } })).toThrow(); // 空 SET
    expect(() => draftOpSchema.parse({ op: "set_action", object: "vendor", name: "a", def: { effect: [{ fly: {} }] } })).toThrow(); // 未知效应
  });
  it("replace_object：def 是单个类体；缺 def / 把 object 当类体都拒", () => {
    expect(() => draftOpSchema.parse({ op: "replace_object", name: "vendor" })).toThrow();
    expect(() => draftOpSchema.parse({ op: "replace_object", name: "vendor", object: { kind: "thing", properties: {} } })).toThrow();
    expect(() => draftOpSchema.parse({ op: "replace_object", name: "vendor", def: { vendor: { kind: "thing", properties: {} } } })).toThrow(); // 整张 map 不是类体
  });
  it("replace_object 的类体剥掉 actions / axioms（不报错、也不进解析结果）", () => {
    const op = draftOpSchema.parse({
      op: "replace_object",
      name: "vendor",
      def: {
        kind: "thing",
        properties: {},
        actions: { a: { effect: [{ delete: { object: "vendor", identity: { from: "identity" } } }] } },
        axioms: { x: { type: "mutex", property: "p" } },
      },
    });
    if (op.op !== "replace_object") throw new Error("unreachable");
    expect("actions" in op.def).toBe(false);
    expect("axioms" in op.def).toBe(false);
    expect(op.def.kind).toBe("thing");
  });
  it("mcpDraftOpSchema 没有 save_layout；其余与 REST 同套", () => {
    expect(() => mcpDraftOpSchema.parse({ op: "save_layout", positions: {} })).toThrow();
    expect(mcpDraftOpSchema.parse({ op: "replace_object", name: "vendor", def: { kind: "thing", properties: {} } })).toBeTruthy();
  });
});

describe("queryRequestSchema / actionRequestSchema", () => {
  it("查询：缺 object 被拒；limit 超上限被拒、压线放行", () => {
    expect(() => queryRequestSchema.parse({})).toThrow();
    expect(() => queryRequestSchema.parse({ object: "equipment", limit: 1001 })).toThrow();
    expect(queryRequestSchema.parse({ object: "equipment", limit: 1000 }).limit).toBe(1000);
  });
  it("order 只支持单键；聚合每条只写一个键；空 group_by = 全体合计", () => {
    expect(() => queryRequestSchema.parse({ object: "equipment", order: { a: "asc", b: "desc" } })).toThrow(/单键/);
    expect(() => queryRequestSchema.parse({ object: "equipment", aggregate: { group_by: ["dept"], metrics: [{ count: "*", avg: "x" }] } })).toThrow(/只写一个键/);
    expect(queryRequestSchema.parse({ object: "equipment", aggregate: { group_by: [], metrics: [{ count: "*" }] } }).aggregate?.group_by).toEqual([]); // 总数聚合
    expect(queryRequestSchema.parse({ object: "equipment", aggregate: { metrics: [{ count: "*" }] } }).aggregate?.group_by).toEqual([]); // 缺省同空
  });
  it("动作：identity 缺了被拒", () => {
    expect(() => actionRequestSchema.parse({ action: "convert", object: "equipment" })).toThrow();
    expect(actionRequestSchema.parse({ action: "convert", object: "equipment", identity: "SN-1" }).identity).toBe("SN-1");
  });
});

describe("walkFilter（过滤树走查器）", () => {  const config = configSchema.parse({
    object_types: {
      a: { kind: "thing", properties: { x: { type: "string" } } },
      b: { kind: "thing", properties: { y: { type: "string" } } },
    },
    link_types: { ab: { from: "a", to: "b", inverse: "ba", match: [{ from: "x", to: "y" }] } },
  });

  it("prop/link/special 事件齐备，target 解析正确，depth 递增", () => {
    const events: unknown[][] = [];
    walkFilter(
      config,
      "a",
      { x: 1, $request: { p: 2 }, $link: { ab: { y: 3 } } },
      {
        prop: (cls, k, _v, depth) => void events.push(["prop", cls, k, depth]),
        link: (cls, n, target, _s, depth) => void events.push(["link", cls, n, target, depth]),
        special: (cls, k) => void events.push(["special", cls, k]),
      }
    );
    expect(events).toEqual([
      ["prop", "a", "x", 0],
      ["special", "a", "$request"],
      ["link", "a", "ab", "b", 0],
      ["prop", "b", "y", 1],
    ]);
  });

  it("link 事件返回 false 不递归；config 为 null 时 target 为 null（结构遍历）", () => {
    const seen: string[] = [];
    walkFilter(config, "a", { $link: { ab: { y: 3 } } }, { link: () => false, prop: (_c, k) => seen.push(k) });
    expect(seen).toEqual([]);
    const targets: unknown[] = [];
    walkFilter(null, "a", { $link: { ab: { y: 3 } } }, { link: (_c, _n, t) => void targets.push(t) });
    expect(targets).toEqual([null]);
  });

  it("反向关系名（inverse）解析到 from 侧", () => {
    const targets: unknown[] = [];
    walkFilter(config, "b", { $link: { ba: { x: 1 } } }, { link: (_c, _n, t) => void targets.push(t) });
    expect(targets).toEqual(["a"]);
  });

  it("$link 子值是 true/false（存在性写法）只发事件不递归", () => {
    const events: string[] = [];
    walkFilter(config, "a", { $link: { ab: true } }, {
      link: (_c, n) => void events.push(`link:${n}`),
      prop: (_c, k) => void events.push(`prop:${k}`),
    });
    expect(events).toEqual(["link:ab"]);
  });
});

describe("valueSpec（取值来源词表的唯一事实源）", () => {
  it("EXPR_LIKE：now 系与 current./request. 前缀算表达式，普通文本不算", () => {
    for (const s of ["now", "now/d", "now+1y", "now-1d/d", "current.dept", "request.title"]) expect(EXPR_LIKE.test(s)).toBe(true);
    for (const s of ["nowadays", "normal", "D01", "2026-01-01"]) expect(EXPR_LIKE.test(s)).toBe(false);
  });
  it("FROM_KEY_SET 恰好六个词", () => {
    expect([...FROM_KEY_SET].sort()).toEqual(["action", "current", "generated", "identity", "object", "request"]);
  });
  it("isFromOnly：恰为单键 { from: key } 才真", () => {
    expect(isFromOnly({ from: "identity" }, "identity")).toBe(true);
    expect(isFromOnly({ from: "identity" }, "request")).toBe(false);
    expect(isFromOnly({ from: "identity", extra: 1 }, "identity")).toBe(false); // 多一个键不算
    expect(isFromOnly("identity", "identity")).toBe(false);
    expect(isFromOnly(null, "identity")).toBe(false);
  });
  it("propertyRef：只认 { property: 字符串 }，from 原样带出", () => {
    expect(propertyRef({ property: "dept" })).toEqual({ property: "dept", from: undefined });
    expect(propertyRef({ property: "dept", from: "request" })).toEqual({ property: "dept", from: "request" });
    expect(propertyRef({ from: "identity" })).toBeNull();
    expect(propertyRef("dept")).toBeNull();
  });
  it("isPlainLiteral：字面量为真，表达式串与对象为假", () => {
    expect(isPlainLiteral("D01")).toBe(true);
    expect(isPlainLiteral(1)).toBe(true);
    expect(isPlainLiteral(null)).toBe(true);
    expect(isPlainLiteral("now/d")).toBe(false);
    expect(isPlainLiteral({ from: "request" })).toBe(false);
  });
});

describe("executionPlan（人点的关系类型 → 定案顺序与时期名）", () => {
  const a = "device";
  const b = "asset";

  it("类等价：建议留下谁就先写谁；点名不在这一对上或没给，留下 class_a", () => {
    expect(executionPlan(a, b, Verdict.Same, { keep: b }).order).toEqual([b, a]);
    expect(executionPlan(a, b, Verdict.Same, { keep: a }).order).toEqual([a, b]);
    expect(executionPlan(a, b, Verdict.Same, { keep: "ghost" }).order).toEqual([a, b]);
    expect(executionPlan(a, b, Verdict.Same, {}).order).toEqual([a, b]);
  });

  it("生命周期：较早的类先写；时期名缺了用中性占位 early / late", () => {
    expect(executionPlan(a, b, Verdict.Stage, { stage: { earlier: b, from: "candidate", to: "employed" } })).toEqual({
      order: [b, a],
      stage: { from: "candidate", to: "employed" },
    });
    expect(executionPlan(a, b, Verdict.Stage, {})).toEqual({
      order: [a, b],
      stage: { from: "early", to: "late" },
    });
  });

  it("stageValues：占位词带中文名（早期/晚期），建议词裸 key", () => {
    expect(stageValues("early", "late")).toEqual([
      { value: "early", label: "早期" },
      { value: "late", label: "晚期" },
    ]);
    expect(stageValues("in_transit", "in_service")).toEqual([{ value: "in_transit" }, { value: "in_service" }]);
  });

  it("cleanAdvice：stage 只在生命周期倾向保留；词空就整个去掉", () => {
    const base = { class_a: "a", class_b: "b", reason: "r" };
    expect(cleanAdvice({ ...base, tendency: Verdict.Same, stage: { earlier: "a", from: "x", to: "y" } }).stage).toBeUndefined();
    expect(cleanAdvice({ ...base, tendency: Verdict.Stage, stage: { earlier: "a", from: "", to: "y" } }).stage).toBeUndefined();
    expect(cleanAdvice({ ...base, tendency: Verdict.Stage }).stage).toBeUndefined();
    expect(cleanAdvice({ ...base, tendency: Verdict.Stage, stage: { earlier: "a", from: "x", to: "y" } }).stage).toEqual({
      earlier: "a",
      from: "x",
      to: "y",
    });
  });

  it("部分重叠 / 同形异义 / 跳过：顺序就是这一对，不带时期名", () => {
    expect(executionPlan(a, b, Verdict.Overlap, { keep: b }).order).toEqual([a, b]);
    expect(executionPlan(a, b, Verdict.NameSimilar, { stage: { earlier: b, from: "x", to: "y" } }).stage).toBeUndefined();
    expect(executionPlan(a, b, Verdict.Skip, {}).order).toEqual([a, b]);
  });
});
