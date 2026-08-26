// 待确认面板：唯一键行派生（排除派生字段、标记模型建议、无候选不进行）+ 渲染冒烟（两段解锁）。
import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import DecisionPanel, { identityRows } from "../components/cards/DecisionPanel";

const t = (identity: string | undefined, props: Record<string, { derived?: boolean; description?: string }>) => ({
  identity,
  properties: props,
});

const idle = {
  pairs: [] as [],
  onConfirmIdentity: async () => true,
  onPairDone: () => {},
  onClose: () => {},
};

describe("identityRows（待确认面板的唯一键行）", () => {
  it("派生字段不列为候选；当前 identity 标记为建议值", () => {
    const rows = identityRows(
      { person: t("id_no", { id_no: { description: "身份证号" }, status: { derived: true, description: "在职状态" } }) },
      ["person"]
    );
    expect(rows).toEqual([{ name: "person", current: "id_no", fields: [{ name: "id_no", description: "身份证号" }] }]);
  });

  it("identity 未设置（模型没给）也进卡，当前值为空串", () => {
    const rows = identityRows({ po: t(undefined, { sn: { description: "设备序列号" } }) }, ["po"]);
    expect(rows[0].current).toBe("");
  });

  it("没有可当唯一键的字段的对象不进卡（如只剩派生字段）", () => {
    const rows = identityRows({ ghost: t("", { status: { derived: true } }) }, ["ghost"]);
    expect(rows).toEqual([]);
  });

  it("按传入名字的顺序出卡；草稿里已不存在的名字跳过", () => {
    const rows = identityRows({ b: t("x", { x: {} }), a: t("y", { y: {} }) }, ["a", "gone", "b"]);
    expect(rows.map((r) => r.name)).toEqual(["a", "b"]);
  });
});

describe("DecisionPanel 渲染冒烟（react-dom/server，无 DOM 环境）", () => {
  const strip = (html: string) => html.replace(/<!-- -->/g, "");

  it("初始状态：唯一键区块可见，疑似重复区块锁定提示在；不用「认人字段」", () => {
    const html = strip(
      renderToString(
        <DecisionPanel
          rows={identityRows({ po: t("po_id", { po_id: { description: "采购条目ID" }, sn: { description: "设备序列号" } }) }, ["po"])}
          {...idle}
        />
      )
    );
    expect(html).toContain("待确认");
    expect(html).toContain("① 唯一键（1 个对象）");
    expect(html).toContain("po_id（采购条目ID）");
    expect(html).toContain("模型建议");
    expect(html).not.toContain("po_id（采购条目ID） · 模型建议"); // 建议是格子上的标记，不塞进下拉文字
    expect(html).toContain("确认唯一键");
    expect(html).toContain("② 疑似重复");
    expect(html).toContain("先确认①唯一键，这里才展开"); // 未确认前不渲染 PairCard 列表
    expect(html).not.toContain("认人字段");
    expect(html).not.toMatch(/disabled[^>]*>确认唯一键/); // 已有建议值，确认可点
  });

  it("唯一键未设置时确认按钮不可点", () => {
    const html = strip(
      renderToString(
        <DecisionPanel rows={identityRows({ po: t(undefined, { sn: { description: "设备序列号" } }) }, ["po"])} {...idle} />
      )
    );
    expect(html).toMatch(/disabled[^>]*>确认唯一键/);
  });
});
