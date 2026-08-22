// 对象卡动作区纯函数测试：effectSummary 摘要、formCompatible 白名单、externalToast 判定顺序。
// 演示五条动作（convert/transfer/scrap/register/finish_repair）必须都不兼容——超出表单子集的动作只展示、只许删。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "js-yaml";
import { describe, expect, it } from "vitest";
import { effectSummary, externalToast, formCompatible } from "../components/actionView";
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

describe("externalToast（轮询 toast 判定顺序）", () => {
  const frame = (names: string[], ac?: { added?: string[]; overwritten?: string[]; removed?: string[] }) => ({
    object_types: Object.fromEntries(names.map((n) => [n, {}])),
    action_changes: { added: ac?.added ?? [], overwritten: ac?.overwritten ?? [], removed: ac?.removed ?? [] },
  });

  it("对象键增减与动作变化拼一句；只动作变化点名动作；只对象键走三句；都不变走默认句", () => {
    // 1. 对象键有增减且动作差集非空
    expect(externalToast(frame(["equipment"]), frame(["equipment", "vendor"], { added: ["equipment.convert"] }))).toBe(
      "草稿有更新，已刷新（新对象：vendor；动作有更新：equipment.convert）"
    );
    // 2. 只有动作变化（对象键不变；同名覆盖也算）
    expect(externalToast(frame(["equipment"]), frame(["equipment"], { overwritten: ["equipment.convert", "equipment.scrap"] }))).toBe(
      "草稿有更新，已刷新（动作有更新：equipment.convert、equipment.scrap）"
    );
    // 3a. 只有新增
    expect(externalToast(frame(["equipment"]), frame(["equipment", "vendor", "site"]))).toBe("草稿有更新，已刷新（新对象：vendor、site）");
    // 3b. 只有去掉
    expect(externalToast(frame(["equipment", "vendor"]), frame(["equipment"]))).toBe("草稿有更新，已刷新（已去掉：vendor）");
    // 3c. 新增和去掉都有
    expect(externalToast(frame(["equipment", "site"]), frame(["equipment", "vendor"]))).toBe("草稿有更新，已刷新（新对象：vendor；已去掉：site）");
    // 4. 对象键不变、动作差集全空（只改了字段/关系/描述）
    expect(externalToast(frame(["equipment"]), frame(["equipment"]))).toBe("草稿有更新，已刷新");
  });
});
