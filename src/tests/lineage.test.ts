// 血缘反查测试：列 → 本体属性；主键单列一行；未命中是「未映射」。

import { describe, expect, it } from "vitest";
import { columnTarget } from "../server/engine/draft/lineage";

const config = {
  object_types: {
    equipment: {
      sources: {
        device: { connection: "device_sys", table: "device", pk: "dev_id", fields: { name: "name", serial_no: "serial_no", mark: "status" } },
        purchase: { connection: "purchase_sys", table: "po_item", pk: "po_id", fields: { name: "item_name", serial_no: "sn" } },
      },
    },
  },
} as never;

describe("columnTarget（列 → 本体属性 的血缘反查）", () => {
  it("命中字段映射、命中主键、未命中各归各位；同名列按源条目区分", () => {
    expect(columnTarget(config, "device_sys", "device", "status")).toBe("equipment.mark（device）");
    expect(columnTarget(config, "purchase_sys", "po_item", "sn")).toBe("equipment.serial_no（purchase）");
    expect(columnTarget(config, "device_sys", "device", "dev_id")).toBe("equipment 的主键（device）");
    expect(columnTarget(config, "device_sys", "device", "ghost")).toBe("未映射");
    expect(columnTarget(config, "device_sys", "po_item", "sn")).toBe("未映射"); // 表不对不串
  });
});
