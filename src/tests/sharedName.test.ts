// 公共对象名：shared_${a}_${b} 起名。纯函数零夹具（features/ontology/sharedName.ts）。

import { describe, expect, it } from "vitest";
import { isSharedObjectName, sharedEnds, sharedObjectName } from "../server/features/ontology/sharedName";

describe("isSharedObjectName", () => {
  it("只认 shared_ 前缀的类名", () => {
    expect(isSharedObjectName("shared_asset_device")).toBe(true);
    expect(isSharedObjectName("asset")).toBe(false);
  });
});

describe("sharedObjectName", () => {
  it("两个原类拼成 shared_A_B", () => {
    expect(sharedObjectName("asset", "device")).toBe("shared_asset_device");
  });
  it("一端已经是公共对象时，再立的名字是 shared_shared_x_y_z", () => {
    expect(sharedObjectName("shared_x_y", "z")).toBe("shared_shared_x_y_z");
  });
});

describe("sharedEnds", () => {
  it("两端都在才拆得出", () => {
    expect(sharedEnds("shared_asset_device", new Set(["asset", "device", "shared_asset_device"]))).toEqual([
      { a: "asset", b: "device" },
    ]);
    expect(sharedEnds("shared_asset_device", new Set(["asset", "shared_asset_device"]))).toEqual([]);
  });
});
