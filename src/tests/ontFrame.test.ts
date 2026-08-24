// 帧 → 视图模型测试：externalToast 判定顺序 + 收卡策略。

import { describe, expect, it } from "vitest";
import { externalToast, shouldCloseObjectCard, type OntologyResp } from "../components/ontFrame";

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
