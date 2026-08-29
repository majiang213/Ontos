// 画布投影 class_conclusions：由来边、同形异义芯片、节点头上的裁决结论徽章。不猜 shared_A_B。

import { describe, expect, it } from "vitest";
import type { ClassConclusion } from "../server/schema/config";
import { homonymPeerMap, overlapLinksOf, verdictBadgesOf } from "../components/canvas/sharedOrigin";

describe("overlapLinksOf", () => {
  it("每个原类一条边，指向上位对象，标「公共部分」", () => {
    expect(
      overlapLinksOf([{ kind: "overlap", classes: ["asset", "device"], shared: "shared_asset_device" }])
    ).toEqual([
      {
        name: "shared:shared_asset_device:asset",
        from: "asset",
        to: "shared_asset_device",
        description: "公共部分",
        kind: "shared",
      },
      {
        name: "shared:shared_asset_device:device",
        from: "device",
        to: "shared_asset_device",
        description: "公共部分",
        kind: "shared",
      },
    ]);
  });

  it("同形异义和子类型不画由来边", () => {
    expect(overlapLinksOf([{ kind: "homonym", classes: ["a", "b"] }])).toEqual([]);
    expect(overlapLinksOf([{ kind: "subtype", classes: ["intern", "employee"] }])).toEqual([]);
  });
});

describe("homonymPeerMap", () => {
  it("一行一次裁决，不把多对收成一团", () => {
    const m = homonymPeerMap([
      { kind: "homonym", classes: ["fund_account", "login_account"] },
      { kind: "homonym", classes: ["fund_account", "member_account"] },
    ]);
    expect(m.get("fund_account")).toEqual(["login_account", "member_account"]);
    expect(m.get("login_account")).toEqual(["fund_account"]);
    expect(m.get("member_account")).toEqual(["fund_account"]);
  });
});

describe("verdictBadgesOf（节点头上的裁决结论徽章）", () => {
  const rows: ClassConclusion[] = [
    { kind: "overlap", classes: ["asset", "device"], shared: "shared_asset_device" },
    { kind: "homonym", classes: ["fund_account", "login_account"] },
  ];

  it("部分重叠：原类标「部分重叠」，上位对象标「公共对象」，互不混淆", () => {
    expect(verdictBadgesOf(rows, "asset")).toEqual(["部分重叠"]);
    expect(verdictBadgesOf(rows, "shared_asset_device")).toEqual(["公共对象"]);
  });

  it("生命周期来自自环转化（调用方以 stage 告知），与同形异义可叠加", () => {
    expect(verdictBadgesOf(rows, "fund_account", { stage: true })).toEqual(["生命周期", "同形异义"]);
    expect(verdictBadgesOf(rows, "device", { stage: true })).toEqual(["部分重叠", "生命周期"]);
  });

  it("没被任何结论点名的对象不标；类等价合并后不留痕，本就不该有行", () => {
    expect(verdictBadgesOf(rows, "person")).toEqual([]);
    expect(verdictBadgesOf([], "asset", { stage: true })).toEqual(["生命周期"]);
  });
});
