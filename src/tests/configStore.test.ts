// 配置存储测试 —— 工作副本、发布、放弃，以及发布后引擎立即可见。
// 每个用例在独立临时目录里跑：复制种子配置进去，元库（共享 SQLite）从无到有，不污染仓库。
// B 方案：版本链在 onto_version 表里，不再落版本文件——断言直接查库。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const WS = "default";

let repoRoot: string;
let tmp: string;

beforeEach(() => {
  repoRoot = process.cwd();
  tmp = mkdtempSync(join(tmpdir(), "ontos-store-"));
  mkdirSync(join(tmp, "src/server/config"), { recursive: true });
  cpSync(join(repoRoot, "src/server/config/ontology.yaml"), join(tmp, "src/server/config/ontology.yaml"));
  process.chdir(tmp); // configStore / metaStore 按 process.cwd() 找配置与元库
});

afterEach(async () => {
  (await import("../server/engine/configStore")).resetStore();
  (await import("../server/meta/store")).resetMetaStore(); // 元库单例绑死本轮临时目录，删目录前关掉
  process.chdir(repoRoot);
  rmSync(tmp, { recursive: true, force: true });
});

async function freshStore() {
  const s = await import("../server/engine/configStore");
  s.resetStore();
  return s;
}

async function meta() {
  return (await import("../server/meta/store")).metaStore();
}

describe("配置存储（工作副本与发布）", () => {
  it("初始：草稿=已发布 v1，无改动", async () => {
    const s = await freshStore();
    const state = await s.getDraft(WS);
    expect(state.baseVersion).toBe(1);
    expect(state.dirty).toBe(false);
    expect(state.draft.object_types.equipment).toBeDefined();
  });

  it("新建对象：进草稿、置 dirty；重名与非法名被拒", async () => {
    const s = await freshStore();
    await s.applyOp({ op: "create_object", name: "vendor", description: "供应商", kind: "thing" }, WS);
    expect((await s.getDraft(WS)).dirty).toBe(true);
    expect((await s.getDraft(WS)).draft.object_types.vendor.kind).toBe("thing");
    await expect(s.applyOp({ op: "create_object", name: "vendor", kind: "thing" }, WS)).rejects.toThrow("类已存在");
    await expect(s.applyOp({ op: "create_object", name: "Vendor", kind: "thing" }, WS)).rejects.toThrow();
  });

  it("发布后：版本入元库、引擎读到新版、草稿收口；新类可查", async () => {
    const s = await freshStore();
    await s.applyOp({ op: "create_object", name: "vendor", kind: "thing" }, WS);
    await s.applyOp({ op: "add_property", object: "vendor", name: "vendor_no", type: "string" }, WS);
    await s.applyOp({ op: "set_identity", object: "vendor", name: "vendor_no" }, WS);
    const { version } = await s.publishDraft(WS);
    expect(version).toBe(2);
    expect((await s.getDraft(WS)).dirty).toBe(false);
    expect((await s.getPublished(WS)).version).toBe(2);
    expect((await s.getPublished(WS)).config.object_types.vendor.identity).toBe("vendor_no");
    expect(await (await meta()).versionYaml(WS, 2)).toBeDefined(); // v2 快照在 onto_version
    // 引擎读已发布：新类可查（无源 → 空结果，不报错）
    const { runQuery } = await import("../server/engine/query");
    const { freshDriver } = await import("../server/engine/load");
    const res = await runQuery((await s.getPublished(WS)).config, freshDriver(), { object: "vendor" });
    expect(res.rows).toEqual([]);
  });

  it("发布不合法配置被拒：识别字段指向不存在的属性", async () => {
    const s = await freshStore();
    await s.applyOp({ op: "create_object", name: "vendor", kind: "thing" }, WS);
    await s.applyOp({ op: "add_property", object: "vendor", name: "vendor_no", type: "string" }, WS);
    (await s.getDraft(WS)).draft.object_types.vendor.identity = "ghost"; // 绕过 applyOp 写坏草稿，验证发布闸
    await expect(s.publishDraft(WS)).rejects.toThrow();
  });

  it("放弃：草稿回退到已发布快照", async () => {
    const s = await freshStore();
    await s.applyOp({ op: "create_object", name: "vendor", kind: "thing" }, WS);
    expect((await s.getDraft(WS)).dirty).toBe(true);
    await s.discardDraft(WS);
    const state = await s.getDraft(WS);
    expect(state.dirty).toBe(false);
    expect(state.draft.object_types.vendor).toBeUndefined();
  });

  it("编辑操作守卫：删识别字段被拒；派生属性不能当识别字段；摆位不置 dirty", async () => {
    const s = await freshStore();
    await expect(s.applyOp({ op: "remove_property", object: "equipment", name: "serial_no" }, WS)).rejects.toThrow("识别字段");
    await expect(s.applyOp({ op: "set_identity", object: "equipment", name: "status" }, WS)).rejects.toThrow("派生属性");
    await s.applyOp({ op: "save_layout", positions: { equipment: { x: 10, y: 20 } } }, WS);
    expect((await s.getDraft(WS)).dirty).toBe(false);
    expect((await s.getDraft(WS)).layout.equipment).toEqual({ x: 10, y: 20 });
  });

  it("发布后状态比较不受键序影响（zod parse 会重排键）", async () => {
    const s = await freshStore();
    await s.applyOp({ op: "create_object", name: "vendor", kind: "thing" }, WS);
    await s.applyOp({ op: "add_property", object: "vendor", name: "vendor_no", type: "string" }, WS);
    await s.applyOp({ op: "set_identity", object: "vendor", name: "vendor_no" }, WS);
    await s.publishDraft(WS);
    // zod parse 后键序不同，但结构比较应判 same
    expect(s.sameConfig((await s.getPublished(WS)).config.object_types.vendor, (await s.getDraft(WS)).draft.object_types.vendor)).toBe(true);
  });

  it("重启路径：发布后清内存，从元库版本链读回 v2", async () => {
    const s = await freshStore();
    await s.applyOp({ op: "create_object", name: "vendor", kind: "thing" }, WS);
    await s.publishDraft(WS);
    s.resetStore(); // 模拟重启：内存态清空
    expect((await s.getPublished(WS)).version).toBe(2);
    expect((await s.getPublished(WS)).config.object_types.vendor).toBeDefined();
  });

  it("未知操作被拒，不置 dirty", async () => {
    const s = await freshStore();
    await expect(s.applyOp({ op: "fly_to_moon" } as never, WS)).rejects.toThrow("未知操作");
    expect((await s.getDraft(WS)).dirty).toBe(false);
  });

  it("识别字段可取消（空串）；改出去又改回来 dirty 能收回", async () => {
    const s = await freshStore();
    // 有源类取消识别字段就没有认行依据——校验闸拒绝（无源对象才可无 identity）
    await expect(s.applyOp({ op: "set_identity", object: "equipment", name: "" }, WS)).rejects.toThrow("认行依据");
    expect((await s.getDraft(WS)).dirty).toBe(false); // 被拒的操作不留痕
    await s.applyOp({ op: "set_identity", object: "equipment", name: "name" }, WS);
    expect((await s.getDraft(WS)).dirty).toBe(true);
    await s.applyOp({ op: "set_identity", object: "equipment", name: "serial_no" }, WS); // 改回去
    expect((await s.getDraft(WS)).dirty).toBe(false);
  });

  it("删被引用的属性被拒，并报出引用处", async () => {
    const s = await freshStore();
    await expect(s.applyOp({ op: "remove_property", object: "equipment", name: "mark" }, WS)).rejects.toThrow("仍被引用");
  });

  it("手动连线：建关系、删关系；重名与配对字段不存在被拒；被引用的关系删不掉", async () => {
    const s = await freshStore();
    await s.applyOp({ op: "create_link", name: "located_in", from: "equipment", to: "department", match: { from: "dept", to: "dept_id" }, card: "n:1" }, WS);
    expect((await s.getDraft(WS)).draft.link_types.located_in.match).toEqual([{ from: "dept", to: "dept_id" }]);
    expect((await s.getDraft(WS)).dirty).toBe(true);
    // 重名拒绝
    await expect(s.applyOp({ op: "create_link", name: "located_in", from: "equipment", to: "department", match: { from: "dept", to: "dept_id" } }, WS)).rejects.toThrow("已存在");
    // 配对字段不存在拒绝
    await expect(s.applyOp({ op: "create_link", name: "bad_link", from: "equipment", to: "department", match: { from: "ghost", to: "dept_id" } }, WS)).rejects.toThrow("没有属性");
    // 端点不存在拒绝
    await expect(s.applyOp({ op: "create_link", name: "bad2", from: "equipment", to: "ghost", match: { from: "dept", to: "x" } }, WS)).rejects.toThrow("类不存在");
    // 被动作引用的转化关系删不掉
    await expect(s.applyOp({ op: "delete_link", name: "converted" }, WS)).rejects.toThrow("仍被引用");
    // 普通关系能删
    await s.applyOp({ op: "delete_link", name: "located_in" }, WS);
    expect((await s.getDraft(WS)).draft.link_types.located_in).toBeUndefined();
  });

  it("无改动发布是空操作：版本不变、不入库", async () => {
    const s = await freshStore();
    const { version } = await s.publishDraft(WS);
    expect(version).toBe(1);
    expect(await (await meta()).versionYaml(WS, 2)).toBeUndefined(); // 没有 v2
  });

  it("回滚守卫：草稿脏时拒绝；版本不存在拒绝", async () => {
    const s = await freshStore();
    await s.applyOp({ op: "create_object", name: "vendor", kind: "thing" }, WS); // 弄脏草稿
    await expect(s.rollbackTo(1, WS)).rejects.toThrow("先发布或放弃");
    await s.discardDraft(WS); // 干净了再验版本守卫
    await expect(s.rollbackTo(99, WS)).rejects.toThrow("版本不存在");
  });

  it("导入整批原子：半途撞名不留下前几个类", async () => {
    const s = await freshStore();
    // 第二个类撞已存在的 equipment：整批应拒绝，draft 里不能留下 vendor_ok
    await expect(
      s.applyOp(
        {
          op: "import_objects",
          objects: {
            vendor_ok: { kind: "thing", properties: {} },
            equipment: { kind: "thing", properties: {} }, // 撞名
          },
        },
        WS
      )
    ).rejects.toThrow("类已存在");
    expect((await s.getDraft(WS)).draft.object_types.vendor_ok).toBeUndefined(); // 没有部分应用
    expect((await s.getDraft(WS)).dirty).toBe(false);
    // 非法类名同样整批拒
    await expect(s.applyOp({ op: "import_objects", objects: { Bad_Name: { kind: "thing", properties: {} } } }, WS)).rejects.toThrow("类名");
    expect((await s.getDraft(WS)).draft.object_types.Bad_Name).toBeUndefined();
  });

  it("放弃草稿：未绑版本的裁决留痕标「已放弃」，不挂到下一次发布", async () => {
    const s = await freshStore();
    const m = await meta();
    await s.applyOp({ op: "create_object", name: "vendor", kind: "thing" }, WS);
    await m.recordDecision(WS, { class_a: "a", class_b: "b", source_a: "s1", source_b: "s2", verdict: "跳过", decided_by: "测试" });
    await s.discardDraft(WS);
    expect((await m.listDecisions(WS))[0].version).toBe(-1); // 已放弃
    // 下一次发布不回填它
    await s.applyOp({ op: "create_object", name: "vendor2", kind: "thing" }, WS);
    await s.publishDraft(WS);
    expect((await m.listDecisions(WS))[0].version).toBe(-1);
  });

  it("跨类动作引用守卫：删 repair.is_open 被拒（equipment.finish_repair 在用）", async () => {
    const s = await freshStore();
    await expect(s.applyOp({ op: "remove_property", object: "repair", name: "is_open" }, WS)).rejects.toThrow("仍被引用");
    await expect(s.applyOp({ op: "remove_property", object: "repair", name: "is_open" }, WS)).rejects.toThrow("finish_repair");
  });

  it("发布闸拦动作里的坏引用：效应指向不存在的类", async () => {
    const s = await freshStore();
    await s.applyOp({ op: "create_object", name: "vendor", kind: "thing" }, WS); // 先产生合法改动，置 dirty
    (await s.getDraft(WS)).draft.object_types.equipment.actions!.bad = {
      effect: [{ update: { object: "ghost_class", filter: { x: 1 }, properties: { y: 2 } } }],
    };
    await expect(s.publishDraft(WS)).rejects.toThrow("不存在的类");
  });
});
