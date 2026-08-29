// 待确认面板：唯一键行派生（排除派生字段、标记模型建议、无候选不进行）+ 渲染冒烟（两段解锁）。
import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import DecisionPanel, { identityRows, mergeSelections } from "../components/cards/DecisionPanel";
import PairCard from "../components/cards/PairCard";
import { VERDICT_LABELS, Verdict } from "../server/schema/verdict";

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

describe("mergeSelections（面板开着时对象增删的选择同步）", () => {
  const row = (name: string, current: string) => ({ name, current, fields: [{ name: current || "sn" }] });

  it("新对象进卡补草稿当前键——部分重叠立公共对象后不打回①", () => {
    const sel = { asset: "asset_id", device: "serial_no" };
    const rows = [row("asset", "asset_id"), row("device", "serial_no"), row("shared_asset_device", "asset_id")];
    expect(mergeSelections(sel, rows)).toEqual({ asset: "asset_id", device: "serial_no", shared_asset_device: "asset_id" });
  });

  it("用户改过的选择不被草稿值覆盖；消失的对象清掉", () => {
    const sel = { asset: "serial_no", device: "serial_no" }; // asset 被用户改成 serial_no
    const rows = [row("asset", "asset_id")]; // device 被并进 asset，消失
    expect(mergeSelections(sel, rows)).toEqual({ asset: "serial_no" });
  });

  it("没有增删时原样返回（同一引用，不触发多余渲染）", () => {
    const sel = { asset: "asset_id" };
    expect(mergeSelections(sel, [row("asset", "asset_id")])).toBe(sel);
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

  it("裁决按钮用类等价 / 部分重叠 / 生命周期 / 同形异义 / 跳过", () => {
    const html = strip(
      renderToString(
        <PairCard pair={{ class_a: "fund_account", class_b: "login_account", tendency: Verdict.NameSimilar, reason: "不是同一种东西" }} onDone={() => {}} />
      )
    );
    expect(html).toContain(VERDICT_LABELS[Verdict.Same]);
    expect(html).toContain(VERDICT_LABELS[Verdict.Overlap]);
    expect(html).toContain(VERDICT_LABELS[Verdict.Stage]);
    expect(html).toContain(VERDICT_LABELS[Verdict.NameSimilar]);
    expect(html).toContain(VERDICT_LABELS[Verdict.Skip]);
    expect(html).not.toContain("仅名称相似");
    expect(html).not.toMatch(/>同一</);
    expect(html).not.toContain("哪个时期更早");
    expect(html).not.toContain("点了之后还要选谁早");
    expect(html).toContain("谁早谁晚、时期名由建议给出");
    expect(html).toContain("留下哪一个由建议给出");
    expect(html).toContain("点「生命周期」会落"); // 建议不倾向生命周期也常显按钮落点：占位词点击前看得见
  });

  it("建议里的留下谁、谁早直接写在卡上，不另开选择器", () => {
    const html = strip(
      renderToString(
        <PairCard
          pair={{
            class_a: "po",
            class_b: "device",
            tendency: Verdict.Stage,
            reason: "同一批设备的不同时期",
            keep: "device",
            stage: { earlier: "po", from: "in_transit", to: "in_service" },
          }}
          onDone={() => {}}
        />
      )
    );
    expect(html).toContain("po 更早");
    expect(html).toContain("in_transit");
    expect(html).toContain("in_service");
    expect(html).not.toContain("哪个时期更早");
    expect(html).not.toContain("定案");
  });

  it("建议没给时期名：卡上显示引擎占位 early → late 并提示可改标识", () => {
    const html = strip(
      renderToString(
        <PairCard
          pair={{
            class_a: "po",
            class_b: "device",
            tendency: Verdict.Stage,
            reason: "同一批设备的不同时期",
            keep: "device",
          }}
          onDone={() => {}}
        />
      )
    );
    expect(html).toContain("po 更早");
    expect(html).toContain("early → late");
    expect(html).toContain("占位词，可改标识");
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
