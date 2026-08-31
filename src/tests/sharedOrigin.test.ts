// 画布上的判定留痕投影测试：统一行（DecisionRow）——现行 adj 行 + 历史行（带 shared 画由来虚线）。

import { describe, expect, it } from "vitest";
import { Verdict } from "../server/schema/verdict";
import { DecisionRow, decisionRowsOf, homonymPeerMap, overlapEdgesOf, verdictBadgesOf } from "../components/canvas/sharedOrigin";

describe("decisionRowsOf（留痕统一行）", () => {
  it("adj 行原样进；历史 class_conclusions 行按 kind 映射（homonym→name_similar、overlap→overlap，带 shared）", () => {
    const rows = decisionRowsOf(
      [
        { kind: "homonym", classes: ["fund_account", "login_account"] },
        { kind: "overlap", classes: ["c", "d"], shared: "shared_c_d" },
      ],
      [{ class_a: "x", class_b: "y", verdict: Verdict.Same }]
    );
    expect(rows).toEqual([
      { classes: ["x", "y"], verdict: Verdict.Same },
      { classes: ["fund_account", "login_account"], verdict: Verdict.NameSimilar, shared: undefined },
      { classes: ["c", "d"], verdict: Verdict.Overlap, shared: "shared_c_d" },
    ]);
  });

  it("非同形异义/部分重叠的历史行（如 subtype）不进统一行", () => {
    const rows = decisionRowsOf([{ kind: "subtype", classes: ["intern", "employee"] }], []);
    expect(rows).toEqual([]);
  });
});

describe("overlapEdgesOf（历史行的由来虚线）", () => {
  it("带 shared 的历史行画由来边（每类一条，标「公共部分」）；新裁决无边", () => {
    const rows: DecisionRow[] = [
      { classes: ["asset", "device"], verdict: Verdict.Overlap, shared: "shared_asset_device" },
      { classes: ["po", "dev"], verdict: Verdict.Overlap },
    ];
    expect(overlapEdgesOf(rows)).toEqual([
      { name: "shared:shared_asset_device:asset", from: "asset", to: "shared_asset_device", description: "公共部分", kind: "shared" },
      { name: "shared:shared_asset_device:device", from: "device", to: "shared_asset_device", description: "公共部分", kind: "shared" },
    ]);
  });

  it("同形异义和无 shared 的行不画由来边", () => {
    expect(overlapEdgesOf([{ classes: ["a", "b"], verdict: Verdict.NameSimilar }])).toEqual([]);
    expect(overlapEdgesOf([{ classes: ["a", "b"], verdict: Verdict.Overlap }])).toEqual([]);
  });
});

describe("homonymPeerMap", () => {
  it("一行一次判定，不把多对收成一团", () => {
    const m = homonymPeerMap([
      { classes: ["fund_account", "login_account"], verdict: Verdict.NameSimilar },
      { classes: ["fund_account", "member_account"], verdict: Verdict.NameSimilar },
    ]);
    expect(m.get("fund_account")).toEqual(["login_account", "member_account"]);
    expect(m.get("login_account")).toEqual(["fund_account"]);
    expect(m.get("member_account")).toEqual(["fund_account"]);
  });
});

describe("verdictBadgesOf（节点头上的判定结论徽章）", () => {
  const rows: DecisionRow[] = [
    { classes: ["asset", "device"], verdict: Verdict.Overlap },
    { classes: ["fund_account", "login_account"], verdict: Verdict.NameSimilar },
  ];

  it("多源归并：原类标「部分重叠」，与同形异义不混淆", () => {
    expect(verdictBadgesOf(rows, "asset")).toEqual(["部分重叠"]);
    expect(verdictBadgesOf(rows, "fund_account")).toEqual(["同形异义"]);
  });

  it("历史 shared_ 上位对象标「公共对象」（旧结论兼容渲染），与新裁决的部分重叠徽章不混", () => {
    const legacy: DecisionRow[] = [
      { classes: ["po_item", "asset"], verdict: Verdict.Overlap, shared: "shared_po_item_asset" },
    ];
    expect(verdictBadgesOf(legacy, "shared_po_item_asset")).toEqual(["公共对象"]);
    expect(verdictBadgesOf(legacy, "po_item")).toEqual(["部分重叠"]);
  });

  it("生命周期来自自环转化（调用方以 stage 告知），与同形异义可叠加", () => {
    expect(verdictBadgesOf(rows, "fund_account", { stage: true })).toEqual(["生命周期", "同形异义"]);
    expect(verdictBadgesOf(rows, "device", { stage: true })).toEqual(["部分重叠", "生命周期"]);
  });

  it("没被任何判定点名的对象不标；类等价合并后不留痕，本就不该有行", () => {
    expect(verdictBadgesOf(rows, "person")).toEqual([]);
    expect(verdictBadgesOf([], "asset", { stage: true })).toEqual(["生命周期"]);
  });
});
