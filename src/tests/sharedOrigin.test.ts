// 公共对象的由来：部分重叠立出的 shared_A_B 在画布上认出两个原类。
// 纯函数零夹具，interface 就是测试面（components/canvas/sharedOrigin.ts）。

import { describe, expect, it } from "vitest";
import { originLinksOf, originTriples } from "../components/canvas/sharedOrigin";

describe("originTriples（shared_A_B 认出两个原类）", () => {
  it("asset 与 device 都在时，shared_asset_device 是它们的公共部分", () => {
    expect(originTriples(["asset", "device", "shared_asset_device"])).toEqual([
      { shared: "shared_asset_device", a: "asset", b: "device" },
    ]);
  });

  it("短前缀和长前缀都能拆时，留下更长的那组（对齐 shared_${a}_${b} 用完整类名）", () => {
    expect(
      originTriples(["po", "po_a", "po_b", "a_po_b", "shared_po_a_po_b"])
    ).toEqual([{ shared: "shared_po_a_po_b", a: "po_a", b: "po_b" }]);
  });

  it("缺一边原类就不认", () => {
    expect(originTriples(["asset", "shared_asset_device"])).toEqual([]);
  });

  it("两个公共对象可以共享一个原类，按公共对象名排序", () => {
    expect(
      originTriples([
        "instrument",
        "shared_asset_instrument",
        "device",
        "shared_asset_device",
        "asset",
      ])
    ).toEqual([
      { shared: "shared_asset_device", a: "asset", b: "device" },
      { shared: "shared_asset_instrument", a: "asset", b: "instrument" },
    ]);
  });
});

describe("originLinksOf（原类 → 公共对象的由来边）", () => {
  it("每个原类一条边，指向公共对象，标「公共部分」，不进配置", () => {
    expect(
      originLinksOf([{ shared: "shared_asset_device", a: "asset", b: "device" }])
    ).toEqual([
      {
        name: "origin:shared_asset_device:asset",
        from: "asset",
        to: "shared_asset_device",
        description: "公共部分",
        kind: "origin",
      },
      {
        name: "origin:shared_asset_device:device",
        from: "device",
        to: "shared_asset_device",
        description: "公共部分",
        kind: "origin",
      },
    ]);
  });
});
