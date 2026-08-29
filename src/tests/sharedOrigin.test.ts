// 画布投影 class_conclusions：由来边和同形异义芯片。不猜 shared_A_B。

import { describe, expect, it } from "vitest";
import { homonymPeerMap, overlapLinksOf } from "../components/canvas/sharedOrigin";

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
