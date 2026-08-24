// 对象卡动作区纯函数测试：effectSummary 摘要、formCompatible 白名单、动作表单往返恒等。轮询 toast 与收卡策略见 ontFrame.test。
// 演示五条动作（convert/transfer/scrap/register/finish_repair）必须都不兼容——超出表单子集的动作只展示、只许删。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";
import { effectSummary, formCompatible, buildActionDef, prefillEff, prefillPre } from "../components/forms/actionView";
import { configSchema, type ActionDef } from "../server/schema/config";

const config = configSchema.parse(load(readFileSync(join(process.cwd(), "src/server/config/ontology.yaml"), "utf8")));

describe("formCompatible（动作表单白名单）", () => {
  it("演示五条动作全部不兼容（对象卡不出现「编辑」，只展示、只许删）", () => {
    for (const a of ["convert", "transfer", "scrap", "register", "finish_repair"]) {
      const def = config.object_types.equipment.actions![a];
      expect(formCompatible(def, "equipment", config), a).toBe(false);
    }
  });

  it("把本类非派生字段写成字面量、且 identity: { from: identity } 的 update 兼容", () => {
    const def = { effect: [{ update: { object: "equipment", identity: { from: "identity" }, properties: { dept: "D01" } } }] } as ActionDef;
    expect(formCompatible(def, "equipment", config)).toBe(true);
    // 前置：本类非派生字段 等于/不等于 字面量 + $link 已发生/未发生，都认
    const withPre = {
      pre: { dept: "D01", mark: { ne: "scrapped" }, $link: { belongs_to: true } },
      effect: [{ update: { object: "equipment", identity: { from: "identity" }, properties: { dept: { from: "request" } } } }],
    } as ActionDef;
    expect(formCompatible(withPre, "equipment", config)).toBe(true);
  });

  it("create 带日期表达式（expiry: now/d）不兼容；from: generated 不兼容", () => {
    const create = {
      effect: [{ create: { object: "warranty_card", properties: { serial_no: { from: "identity" }, expiry: "now/d" } } }],
    } as ActionDef;
    expect(formCompatible(create, "equipment", config)).toBe(false);
    const gen = { effect: [{ create: { object: "warranty_card", properties: { serial_no: { from: "generated" } } } }] } as ActionDef;
    expect(formCompatible(gen, "equipment", config)).toBe(false);
  });

  it("update/delete 缺 identity: { from: identity } 不兼容；跨类 delete 不兼容；前置写派生字段不兼容", () => {
    const noIdentity = { effect: [{ update: { object: "equipment", properties: { dept: "D01" } } }] } as ActionDef;
    expect(formCompatible(noIdentity, "equipment", config)).toBe(false);
    const crossDelete = { effect: [{ delete: { object: "repair", identity: { from: "identity" } } }] } as ActionDef;
    expect(formCompatible(crossDelete, "equipment", config)).toBe(false);
    const derivedPre = { pre: { status: "in_service" }, effect: [{ update: { object: "equipment", identity: { from: "identity" }, properties: { dept: "D01" } } }] } as ActionDef;
    expect(formCompatible(derivedPre, "equipment", config)).toBe(false); // status 是派生字段
  });

  it("link 只许本类上的转化关系；带 inform 不兼容", () => {
    const goodLink = { effect: [{ link: "converted" }] } as ActionDef;
    expect(formCompatible(goodLink, "equipment", config)).toBe(true);
    const matchLink = { effect: [{ link: "belongs_to" }] } as ActionDef; // belongs_to 是 match，不是转化
    expect(formCompatible(matchLink, "equipment", config)).toBe(false);
    const withInform = {
      effect: [{ update: { object: "equipment", identity: { from: "identity" }, properties: { dept: "D01" } } }],
      inform: [{ object: "change", to: ["payroll"], properties: { action: { from: "action" } } }],
    } as ActionDef;
    expect(formCompatible(withInform, "equipment", config)).toBe(false);
  });
});

describe("动作表单往返恒等（白名单放行 ⇒ prefill → buildActionDef 逐键恒等）", () => {
  const roundtrip = (def: ActionDef, clsName = "equipment") => {
    expect(formCompatible(def, clsName, config)).toBe(true); // 守卫：只测白名单放行的
    const built = buildActionDef({
      clsName,
      name: "t_action",
      description: (def as { description?: string }).description ?? "",
      preRows: prefillPre(def),
      effRows: prefillEff(def) ?? [],
    });
    expect(built.ok).toBe(true);
    if (built.ok) expect(built.def).toEqual(def);
  };

  it("演示配置里凡白名单放行的动作都逐键往返（当前五条都不放行，此循环是未来的哨兵）", () => {
    for (const [clsName, cls] of Object.entries(config.object_types)) {
      for (const def of Object.values(cls.actions ?? {})) {
        if (formCompatible(def, clsName, config)) roundtrip(def, clsName);
      }
    }
  });

  it("构造的兼容动作：update 带前置、create 用 identity、delete、link 转化", () => {
    roundtrip({
      pre: { dept: "D01", mark: { ne: "scrapped" }, $link: { belongs_to: true } },
      effect: [{ update: { object: "equipment", identity: { from: "identity" }, properties: { dept: { from: "request" }, mark: "scrapped", name: "x" } } }],
    } as ActionDef);
    roundtrip({ effect: [{ create: { object: "warranty_card", properties: { serial_no: { from: "identity" } } } }] } as ActionDef);
    roundtrip({ effect: [{ delete: { object: "equipment", identity: { from: "identity" } } }] } as ActionDef);
    roundtrip({ effect: [{ link: "converted" }] } as ActionDef);
  });
});

describe("effectSummary（效应摘要）", () => {
  it("四种效应与 inform 都覆盖（含「撤走」——毒性关卡底线）", () => {
    const def = {
      effect: [
        { update: { object: "equipment", identity: { from: "identity" }, properties: { dept: { from: "request" }, mark: "x" } } },
        { delete: { object: "equipment", identity: { from: "identity" } } },
        { create: { object: "warranty_card", properties: { serial_no: { from: "identity" } } } },
        { link: "converted" },
      ],
      inform: [{ object: "change", to: ["payroll"], properties: { action: { from: "action" } } }],
    } as ActionDef;
    expect(effectSummary(def)).toEqual([
      "把 equipment 的 dept、mark 写成新值",
      "撤走 equipment",
      "新建 warranty_card",
      "转化 converted",
      "告知 payroll（change）",
    ]);
  });

  it("同一属性换取值来源或字面量，摘要一行不变", () => {
    const a = effectSummary({ effect: [{ update: { object: "equipment", identity: { from: "identity" }, properties: { dept: { from: "request" } } } }] } as ActionDef);
    const b = effectSummary({ effect: [{ update: { object: "equipment", identity: { from: "identity" }, properties: { dept: "D01" } } }] } as ActionDef);
    expect(a).toEqual(b);
  });
});
