// 帧 → 视图模型测试：externalToast 判定顺序 + 收卡策略 + 版本/发布钮文案。

import { describe, expect, it } from "vitest";
import { externalToast, isBlankSeed, publishTitle, shouldCloseObjectCard, versionLabel, type OntologyResp } from "../components/ontFrame";

const frame = (names: string[], ac?: { added?: string[]; overwritten?: string[]; removed?: string[] }) => ({
  object_types: Object.fromEntries(names.map((n) => [n, {}])),
  action_changes: { added: ac?.added ?? [], overwritten: ac?.overwritten ?? [], removed: ac?.removed ?? [] },
});

describe("externalToast（轮询 toast 判定顺序）", () => {
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

describe("shouldCloseObjectCard（收卡策略）", () => {
  const data = { object_types: { equipment: {} } } as unknown as OntologyResp;
  it("开着的对象已从草稿里去掉：收卡；还在：不收；没开卡：不收", () => {
    expect(shouldCloseObjectCard("vendor", data)).toBe(true);
    expect(shouldCloseObjectCard("equipment", data)).toBe(false);
    expect(shouldCloseObjectCard(null, data)).toBe(false);
  });
});

describe("isBlankSeed / versionLabel（空白种子不算发布过）", () => {
  it("v1 且无对象 = 空白种子（未发布）；有对象或 v2+ = 已发布", () => {
    expect(isBlankSeed({ version: 1, object_types: {} })).toBe(true);
    expect(isBlankSeed({ version: 1, object_types: { equipment: {} } })).toBe(false);
    expect(isBlankSeed({ version: 2, object_types: {} })).toBe(false);
    expect(versionLabel({ version: 1, object_types: {} })).toBe("未发布");
    expect(versionLabel({ version: 3, object_types: { equipment: {} } })).toBe("已发布 v3");
  });
});

describe("publishTitle（发布钮点名）", () => {
  it("删类与动作差集按实际发生的子集拼；全空返回 undefined", () => {
    expect(publishTitle({ deleted: ["vendor"], action_changes: { added: ["equipment.convert"], overwritten: [], removed: ["equipment.scrap"] } })).toBe(
      "将删除：vendor；将新增的动作：equipment.convert；将删除的动作：equipment.scrap"
    );
    expect(publishTitle({ deleted: [], action_changes: { added: [], overwritten: ["equipment.convert"], removed: [] } })).toBe("将更新的动作：equipment.convert");
    expect(publishTitle({ deleted: [], action_changes: { added: [], overwritten: [], removed: [] } })).toBeUndefined();
  });
});
