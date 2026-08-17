// 配置存储测试 —— 工作副本、发布、放弃，以及发布后引擎立即可见。
// 每个用例在独立临时目录里跑：复制种子配置进去，版本目录从无到有，不污染仓库。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let repoRoot: string;
let tmp: string;

beforeEach(() => {
  repoRoot = process.cwd();
  tmp = mkdtempSync(join(tmpdir(), "ontos-store-"));
  mkdirSync(join(tmp, "lib/config"), { recursive: true });
  cpSync(join(repoRoot, "lib/config/ontology.yaml"), join(tmp, "lib/config/ontology.yaml"));
  process.chdir(tmp); // configStore 按 process.cwd() 找配置
});

afterEach(() => {
  process.chdir(repoRoot);
  rmSync(tmp, { recursive: true, force: true });
});

async function freshStore() {
  const s = await import("../lib/engine/configStore");
  s.resetStore();
  return s;
}

describe("配置存储（工作副本与发布）", () => {
  it("初始：草稿=已发布 v1，无改动", async () => {
    const s = await freshStore();
    const state = s.getDraft();
    expect(state.baseVersion).toBe(1);
    expect(state.dirty).toBe(false);
    expect(state.draft.object_types.equipment).toBeDefined();
  });

  it("新建对象：进草稿、置 dirty；重名与非法名被拒", async () => {
    const s = await freshStore();
    s.applyOp({ op: "create_object", name: "vendor", description: "供应商", kind: "thing" });
    expect(s.getDraft().dirty).toBe(true);
    expect(s.getDraft().draft.object_types.vendor.kind).toBe("thing");
    expect(() => s.applyOp({ op: "create_object", name: "vendor", kind: "thing" })).toThrow("类已存在");
    expect(() => s.applyOp({ op: "create_object", name: "Vendor", kind: "thing" })).toThrow();
  });

  it("发布后：版本文件落盘、引擎读到新版、草稿收口；新类可查", async () => {
    const s = await freshStore();
    s.applyOp({ op: "create_object", name: "vendor", kind: "thing" });
    s.applyOp({ op: "add_property", object: "vendor", name: "vendor_no", type: "string" });
    s.applyOp({ op: "set_identity", object: "vendor", name: "vendor_no" });
    const { version } = s.publishDraft();
    expect(version).toBe(2);
    expect(s.getDraft().dirty).toBe(false);
    expect(s.getPublished().version).toBe(2);
    expect(s.getPublished().config.object_types.vendor.identity).toBe("vendor_no");
    expect(existsSync(join(tmp, "lib/config/versions/v2.yaml"))).toBe(true);
    // 引擎读已发布：新类可查（无源 → 空结果，不报错）
    const { runQuery } = await import("../lib/engine/query");
    const { freshDriver } = await import("../lib/engine/load");
    const res = runQuery(s.getPublished().config, freshDriver(), { object: "vendor" });
    expect(res.rows).toEqual([]);
  });

  it("发布不合法配置被拒：识别字段指向不存在的属性", async () => {
    const s = await freshStore();
    s.applyOp({ op: "create_object", name: "vendor", kind: "thing" });
    s.applyOp({ op: "add_property", object: "vendor", name: "vendor_no", type: "string" });
    s.getDraft().draft.object_types.vendor.identity = "ghost"; // 绕过 applyOp 写坏草稿，验证发布闸
    expect(() => s.publishDraft()).toThrow();
  });

  it("放弃：草稿回退到已发布快照", async () => {
    const s = await freshStore();
    s.applyOp({ op: "create_object", name: "vendor", kind: "thing" });
    expect(s.getDraft().dirty).toBe(true);
    s.discardDraft();
    const state = s.getDraft();
    expect(state.dirty).toBe(false);
    expect(state.draft.object_types.vendor).toBeUndefined();
  });

  it("编辑操作守卫：删识别字段被拒；派生属性不能当识别字段；摆位不置 dirty", async () => {
    const s = await freshStore();
    expect(() => s.applyOp({ op: "remove_property", object: "equipment", name: "serial_no" })).toThrow("识别字段");
    expect(() => s.applyOp({ op: "set_identity", object: "equipment", name: "status" })).toThrow("派生属性");
    s.applyOp({ op: "save_layout", positions: { equipment: { x: 10, y: 20 } } });
    expect(s.getDraft().dirty).toBe(false);
    expect(s.getDraft().layout.equipment).toEqual({ x: 10, y: 20 });
  });

  it("发布后状态比较不受键序影响（zod parse 会重排键）", async () => {
    const s = await freshStore();
    s.applyOp({ op: "create_object", name: "vendor", kind: "thing" });
    s.applyOp({ op: "add_property", object: "vendor", name: "vendor_no", type: "string" });
    s.applyOp({ op: "set_identity", object: "vendor", name: "vendor_no" });
    s.publishDraft();
    // zod parse 后键序不同，但结构比较应判 same
    expect(s.sameConfig(s.getPublished().config.object_types.vendor, s.getDraft().draft.object_types.vendor)).toBe(true);
  });

  it("重启路径：发布后清内存，从磁盘版本文件读回 v2", async () => {
    const s = await freshStore();
    s.applyOp({ op: "create_object", name: "vendor", kind: "thing" });
    s.publishDraft();
    s.resetStore(); // 模拟重启：内存态清空
    expect(s.getPublished().version).toBe(2);
    expect(s.getPublished().config.object_types.vendor).toBeDefined();
  });

  it("未知操作被拒，不置 dirty", async () => {
    const s = await freshStore();
    expect(() => s.applyOp({ op: "fly_to_moon" } as never)).toThrow("未知操作");
    expect(s.getDraft().dirty).toBe(false);
  });

  it("识别字段可取消（空串）；改出去又改回来 dirty 能收回", async () => {
    const s = await freshStore();
    s.applyOp({ op: "set_identity", object: "equipment", name: "" });
    expect(s.getDraft().dirty).toBe(true);
    expect(s.getDraft().draft.object_types.equipment.identity).toBeUndefined();
    s.applyOp({ op: "set_identity", object: "equipment", name: "serial_no" }); // 改回去
    expect(s.getDraft().dirty).toBe(false);
  });

  it("删被引用的属性被拒，并报出引用处", async () => {
    const s = await freshStore();
    expect(() => s.applyOp({ op: "remove_property", object: "equipment", name: "mark" })).toThrow("仍被引用");
  });

  it("无改动发布是空操作：版本不变、不落文件", async () => {
    const s = await freshStore();
    const { version } = s.publishDraft();
    expect(version).toBe(1);
    expect(existsSync(join(tmp, "lib/config/versions/v2.yaml"))).toBe(false);
  });

  it("跨类动作引用守卫：删 repair.is_open 被拒（equipment.finish_repair 在用）", async () => {
    const s = await freshStore();
    expect(() => s.applyOp({ op: "remove_property", object: "repair", name: "is_open" })).toThrow("仍被引用");
    expect(() => s.applyOp({ op: "remove_property", object: "repair", name: "is_open" })).toThrow("finish_repair");
  });

  it("发布闸拦动作里的坏引用：效应指向不存在的类", async () => {
    const s = await freshStore();
    s.applyOp({ op: "create_object", name: "vendor", kind: "thing" }); // 先产生合法改动，置 dirty
    s.getDraft().draft.object_types.equipment.actions!.bad = {
      effect: [{ update: { object: "ghost_class", filter: { x: 1 }, properties: { y: 2 } } }],
    };
    expect(() => s.publishDraft()).toThrow("不存在的类");
  });
});
