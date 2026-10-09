// 画布上的判定留痕投影测试：统一行（DecisionRow）——现行 adj 行 + 历史行（带 shared 画由来虚线）。

import { describe, expect, it } from "vitest";
import { Verdict } from "../server/schema/verdict";
import { DecisionRow, decisionRowsOf, homonymHotKey, homonymPairHot, homonymPeerMap, overlapEdgesOf, verdictChipsOf } from "../components/canvas/sharedOrigin";

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

describe("verdictChipsOf（节点底部只留同形异义芯片）", () => {
  const rows: DecisionRow[] = [
    { classes: ["po_item", "device"], verdict: Verdict.Stage },
    { classes: ["asset", "device"], verdict: Verdict.Same },
    { classes: ["a", "device"], verdict: Verdict.NameSimilar },
    { classes: ["po_item", "asset"], verdict: Verdict.Overlap, shared: "shared_po_item_asset" },
    { classes: ["b", "device"], verdict: Verdict.Skip },
  ];

  it("只给同形异义打「同形异义 · 对方类名」；类等价、部分重叠、生命周期、跳过都不打芯片", () => {
    expect(verdictChipsOf(rows, "device").map((c) => c.text)).toEqual(["同形异义 · a"]);
    expect(verdictChipsOf(rows, "asset")).toEqual([]);
    expect(verdictChipsOf(rows, "po_item")).toEqual([]);
    expect(verdictChipsOf(rows, "b")).toEqual([]);
  });

  it("悬停只点亮这一对的两张卡", () => {
    const hot = homonymHotKey("a", "b");
    expect(homonymPairHot(hot, "a")).toBe(true);
    expect(homonymPairHot(hot, "b")).toBe(true);
    expect(homonymPairHot(hot, "c")).toBe(false);
    expect(homonymPairHot(null, "a")).toBe(false);
  });

  it("同形异义芯片是虚线，并带上对方类名；历史 shared_ 对象不标「公共对象」", () => {
    expect(verdictChipsOf(rows, "device")).toEqual([{ text: "同形异义 · a", dashed: true, peer: "a" }]);
    expect(verdictChipsOf(rows, "shared_po_item_asset")).toEqual([]);
  });
});
