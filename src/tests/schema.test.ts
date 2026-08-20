// schema 层契约测试：全平台契约（本体配置、编辑操作、问数/动作请求、过滤树走查）的正反对照例。
// schema 是全平台的单一事实源：什么合法、什么拒绝在这里钉死，不靠路由测试附带覆盖。

import { describe, expect, it } from "vitest";
import { load } from "js-yaml";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { configSchema } from "../server/schema/config";
import { draftOpSchema } from "../server/schema/ops";
import { actionRequestSchema, queryRequestSchema } from "../server/schema/request";
import { walkFilter } from "../server/schema/filterWalk";

describe("configSchema", () => {
  it("种子配置全收（正例骨架）", () => {
    const cfg = configSchema.parse(load(readFileSync(join(process.cwd(), "src/server/config/ontology.yaml"), "utf8")));
    expect(cfg.object_types.equipment).toBeDefined();
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
  it("派生属性进 fields 是语义问题，schema 不抢话（归 validateSemantics）", () => {
    // fields 收任意属性名；派生拦截在引擎语义校验——分层各管一段，这里只钉结构
    const cfg = configSchema.parse({
      object_types: { a: { kind: "thing", properties: { s: { type: "string", derived: { s: "x" } } }, sources: { sa: { connection: "c", table: "t", fields: { s: "col" } } } } },
    });
    expect(cfg.object_types.a.sources!.sa.fields.s).toBe("col");
  });
});

describe("draftOpSchema", () => {
  it("十种操作各收一例", () => {
    const ops: unknown[] = [
      { op: "create_object", name: "vendor", kind: "thing" },
      { op: "delete_object", name: "vendor" },
      { op: "update_object", name: "vendor", description: "供应商" },
      { op: "add_property", object: "vendor", name: "vendor_no", type: "string" },
      { op: "remove_property", object: "vendor", name: "vendor_no" },
      { op: "set_identity", object: "vendor", name: "vendor_no" },
      { op: "save_layout", positions: { vendor: { x: 10, y: 20 } } },
      { op: "create_link", name: "supplies", from: "vendor", to: "equipment", match: { from: "vendor_no", to: "vendor_no" } },
      { op: "delete_link", name: "supplies" },
      { op: "import_objects", objects: { vendor: { kind: "thing", properties: {} } } },
    ];
    for (const op of ops) expect(draftOpSchema.parse(op)).toBeTruthy();
  });
  it("未知操作被拒；save_layout 的坐标必须是数值", () => {
    expect(() => draftOpSchema.parse({ op: "fly_to_moon" })).toThrow();
    expect(() => draftOpSchema.parse({ op: "save_layout", positions: { equipment: { x: "10", y: 20 } } })).toThrow();
  });
});

describe("queryRequestSchema / actionRequestSchema", () => {
  it("查询：缺 object 被拒；limit 超上限被拒、压线放行", () => {
    expect(() => queryRequestSchema.parse({})).toThrow();
    expect(() => queryRequestSchema.parse({ object: "equipment", limit: 1001 })).toThrow();
    expect(queryRequestSchema.parse({ object: "equipment", limit: 1000 }).limit).toBe(1000);
  });
  it("order 只支持单键；聚合每条只写一个键", () => {
    expect(() => queryRequestSchema.parse({ object: "equipment", order: { a: "asc", b: "desc" } })).toThrow(/单键/);
    expect(() => queryRequestSchema.parse({ object: "equipment", aggregate: { group_by: ["dept"], metrics: [{ count: "*", avg: "x" }] } })).toThrow(/只写一个键/);
  });
  it("动作：identity 缺了被拒", () => {
    expect(() => actionRequestSchema.parse({ action: "convert", object: "equipment" })).toThrow();
    expect(actionRequestSchema.parse({ action: "convert", object: "equipment", identity: "SN-1" }).identity).toBe("SN-1");
  });
});

describe("walkFilter（过滤树走查器）", () => {
  const config = configSchema.parse({
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
