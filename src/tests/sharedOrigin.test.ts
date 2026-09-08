// 画布上的判定留痕投影测试：统一行（DecisionRow）——现行 adj 行 + 历史行（带 shared 画由来虚线）。

import { describe, expect, it } from "vitest";
import { Verdict } from "../server/schema/verdict";
import { DecisionRow, decisionRowsOf, homonymPeerMap, overlapEdgesOf, verdictChipsOf } from "../components/canvas/sharedOrigin";

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

describe("verdictChipsOf（节点底部的判定结论芯片）", () => {
  const rows: DecisionRow[] = [
    { classes: ["po_item", "device"], verdict: Verdict.Stage },
    { classes: ["asset", "device"], verdict: Verdict.Same },
    { classes: ["a", "device"], verdict: Verdict.NameSimilar },
    { classes: ["po_item", "asset"], verdict: Verdict.Overlap, shared: "shared_po_item_asset" },
  ];

  it("芯片统一「结论 · 对方」：和谁一目了然；类等价对方已并入，不打芯片", () => {
    expect(verdictChipsOf(rows, "device").map((c) => c.text)).toEqual(["生命周期 · po_item", "同形异义 · a"]);
    expect(verdictChipsOf(rows, "asset").map((c) => c.text)).toEqual(["部分重叠 · po_item"]); // 历史行：源类也标部分重叠（旧世界正确渲染）
  });

  it("虚线只标「两类都留下」（同形异义）；实心标结构变化（并类 / 时期）；历史 shared_ 标公共对象", () => {
    const chips = verdictChipsOf(rows, "device");
    expect(chips.every((c) => c.text.includes("生命周期") ? !c.dashed : true)).toBe(true);
    expect(chips.find((c) => c.text.includes("同形异义"))!.dashed).toBe(true);
    expect(verdictChipsOf(rows, "shared_po_item_asset").map((c) => c.text)).toEqual(["公共对象"]);
  });
});
