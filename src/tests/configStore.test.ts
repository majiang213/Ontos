// 配置存储测试 —— 工作副本、发布、放弃，以及发布后引擎立即可见。
// 每个用例在独立临时目录里跑：复制种子配置进去，元库（共享 SQLite）从无到有，不污染仓库。
// B 方案：版本链在 onto_version 表里，不再落版本文件——断言直接查库。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupRuntime, restartRuntime, setupRuntime } from "./helpers";
import { Verdict } from "../server/engine/verdict";

// 测试数据（演示模板）在 test 空间，所以配置存储的用例跑在 test 上；default 空白起步。

const WS = "test";

let tmp: string;

beforeEach(async () => {
  tmp = await setupRuntime("ontos-store-");
});

afterEach(async () => {
  await cleanupRuntime(tmp);
});

async function freshStore() {
  await restartRuntime(tmp); // 每用例一份干净内存态
  return import("../server/engine/configStore");
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

  it("update_link：改名/改描述/改反向名；被引用的关系改名被拒", async () => {
    const s = await freshStore();
    // 未引用关系：建一条再改
    await s.applyOp({ op: "create_link", name: "covers_x", from: "warranty_card", to: "equipment", match: { from: "serial_no", to: "serial_no" } }, WS);
    await s.applyOp({ op: "update_link", name: "covers_x", new_name: "covers_y", description: "测试改名", inverse: "covered_by_y" }, WS);
    const l = (await s.getDraft(WS)).draft.link_types.covers_y;
    expect(l.description).toBe("测试改名");
    expect(l.inverse).toBe("covered_by_y");
    expect((await s.getDraft(WS)).draft.link_types.covers_x).toBeUndefined();
    // 不存在 / 撞名 / 非法名
    await expect(s.applyOp({ op: "update_link", name: "ghost" }, WS)).rejects.toThrow("关系不存在");
    await expect(s.applyOp({ op: "update_link", name: "covers_y", new_name: "belongs_to" }, WS)).rejects.toThrow("已存在");
    await expect(s.applyOp({ op: "update_link", name: "covers_y", new_name: "Bad Name" }, WS)).rejects.toThrow();
    // 被引用：converted 被 convert 动作的效应引用，改名被拒
    await expect(s.applyOp({ op: "update_link", name: "converted", new_name: "converted2" }, WS)).rejects.toThrow(/仍被引用/);
    // 空串清掉描述与反向名
    await s.applyOp({ op: "update_link", name: "covers_y", description: "", inverse: "" }, WS);
    const l2 = (await s.getDraft(WS)).draft.link_types.covers_y;
    expect(l2.description).toBeUndefined();
    expect(l2.inverse).toBeUndefined();
  });

  it("update_property：改说明/类型/枚举值/改名；被引用改名被拒；唯一键指针跟随", async () => {
    const s = await freshStore();
    // 改类型 + 枚举值
    await s.applyOp({ op: "update_property", object: "equipment", name: "name", type: "enum", values: ["a", "b"] }, WS);
    const p1 = (await s.getDraft(WS)).draft.object_types.equipment.properties.name;
    expect(p1.type).toBe("enum");
    expect(p1.values).toEqual(["a", "b"]);
    // 类型离开 enum：枚举值跟着清掉
    await s.applyOp({ op: "update_property", object: "equipment", name: "name", type: "string" }, WS);
    expect((await s.getDraft(WS)).draft.object_types.equipment.properties.name.values).toBeUndefined();
    // 改说明与空串清掉
    await s.applyOp({ op: "update_property", object: "equipment", name: "name", description: "设备名称" }, WS);
    expect((await s.getDraft(WS)).draft.object_types.equipment.properties.name.description).toBe("设备名称");
    await s.applyOp({ op: "update_property", object: "equipment", name: "name", description: "" }, WS);
    expect((await s.getDraft(WS)).draft.object_types.equipment.properties.name.description).toBeUndefined();
    // 不存在被拒
    await expect(s.applyOp({ op: "update_property", object: "equipment", name: "ghost", description: "x" }, WS)).rejects.toThrow("属性不存在");
    // equipment.name 被源映射引用 → 改名被拒
    await expect(s.applyOp({ op: "update_property", object: "equipment", name: "name", new_name: "dev_name" }, WS)).rejects.toThrow(/仍被引用/);
    // 手工对象的字段改名成功 + 唯一键指针跟随
    await s.applyOp({ op: "create_object", name: "vendor", kind: "thing" }, WS);
    await s.applyOp({ op: "add_property", object: "vendor", name: "vendor_no", type: "string" }, WS);
    await s.applyOp({ op: "set_identity", object: "vendor", name: "vendor_no" }, WS);
    await s.applyOp({ op: "update_property", object: "vendor", name: "vendor_no", new_name: "vendor_code" }, WS);
    const v = (await s.getDraft(WS)).draft.object_types.vendor;
    expect(v.properties.vendor_no).toBeUndefined();
    expect(v.properties.vendor_code).toBeDefined();
    expect(v.identity).toBe("vendor_code");
    await expect(s.applyOp({ op: "update_property", object: "vendor", name: "vendor_code", new_name: "Bad Name" }, WS)).rejects.toThrow();
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

  it("rev：内容变更 +1；摆位不加；放弃后变且不为 0；干净草稿上回滚也 +1", async () => {
    const s = await freshStore();
    expect(s.getRev(WS)).toBe(0);
    await s.applyOp({ op: "create_object", name: "vendor", kind: "thing" }, WS);
    expect(s.getRev(WS)).toBe(1);
    await s.applyOp({ op: "save_layout", positions: { vendor: { x: 1, y: 2 } } }, WS);
    expect(s.getRev(WS)).toBe(1); // 摆位不算本体改动，不催监视器
    const before = s.getRev(WS);
    await s.discardDraft(WS);
    expect(s.getRev(WS)).toBe(before + 1); // 放弃也 +1：草稿内容变了（且永远不归零）
    expect(s.getRev(WS)).not.toBe(0);
    // 干净草稿（rev 可能为正）上回滚也 +1——监视器按相等比较，少了这拍另一标签页会漏刷新
    await s.rollbackTo(1, WS);
    expect(s.getRev(WS)).toBe(before + 2);
  });

  it("rev=0 的干净草稿上 rollbackTo 仍 +1", async () => {
    const s = await freshStore();
    expect(s.getRev(WS)).toBe(0);
    expect((await s.getDraft(WS)).dirty).toBe(false);
    await s.rollbackTo(1, WS);
    expect(s.getRev(WS)).toBe(1);
  });

  it("写队列失败续链：前一次 DraftReject 之后，后续写入仍成功", async () => {
    const s = await freshStore();
    await expect(s.applyOp({ op: "create_object", name: "equipment", kind: "thing" }, WS)).rejects.toThrow("类已存在");
    await s.applyOp({ op: "create_object", name: "vendor", kind: "thing" }, WS); // 不能被上一次拒绝拖死
    expect((await s.getDraft(WS)).draft.object_types.vendor).toBeDefined();
  });

  it("编辑操作守卫：删识别字段被拒；派生属性不能当识别字段；摆位不置 dirty", async () => {
    const s = await freshStore();
    await expect(s.applyOp({ op: "remove_property", object: "equipment", name: "serial_no" }, WS)).rejects.toThrow("认出同一对象靠的字段");
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
    await restartRuntime(tmp); // 模拟重启：内存态清空
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
    await m.recordDecision(WS, { class_a: "a", class_b: "b", source_a: "s1", source_b: "s2", verdict: Verdict.Skip, decided_by: "测试" });
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

describe("整份替换（replace_object）与 base_rev", () => {
  it("未锁定类可整份替换：关系与摆位保留；无源的残缺生成（有字段）也能换", async () => {
    const s = await freshStore();
    // 无源类 + 人手加的字段（后写赢：整份替换会盖掉，不视为锁定）
    await s.applyOp({ op: "create_object", name: "vendor", kind: "thing", description: "旧描述" }, WS);
    await s.applyOp({ op: "add_property", object: "vendor", name: "vendor_no", type: "string" }, WS);
    await s.applyOp({ op: "create_link", name: "vendor_sells", from: "vendor", to: "equipment", match: { from: "vendor_no", to: "serial_no" } }, WS);
    const def = { kind: "thing" as const, description: "新描述", identity: "vendor_no", properties: { vendor_no: { type: "string" as const }, vendor_name: { type: "string" as const } } };
    await s.applyOp({ op: "replace_object", name: "vendor", def }, WS);
    const d = (await s.getDraft(WS)).draft;
    expect(d.object_types.vendor.description).toBe("新描述");
    expect(d.object_types.vendor.identity).toBe("vendor_no");
    expect(d.object_types.vendor.properties.vendor_name).toBeDefined();
    expect(d.link_types.vendor_sells).toBeDefined(); // 关系不随替换消失
  });

  it("类不存在：replace_object 拒绝并指向 import_objects", async () => {
    const s = await freshStore();
    await expect(s.applyOp({ op: "replace_object", name: "ghost", def: { kind: "thing", properties: {} } }, WS)).rejects.toThrow("新建请用 import_objects");
  });

  it("锁定规则：已发布 / 派生 / 多源 / 有源未对照字段 各拒一次；动作与公理走 replaceBlockers 直测；空 map 不误锁", async () => {
    const s = await freshStore();
    // 已发布过的类
    await expect(
      s.applyOp({ op: "replace_object", name: "equipment", def: { kind: "thing", properties: {} } }, WS)
    ).rejects.toThrow(/不能整对象替换：已经发布过/);
    // 含派生字段（无源类：不触发未对照字段锁，钉的是派生这一条）
    await s.applyOp({
      op: "import_objects",
      objects: { with_derived: { kind: "thing", properties: { a: { type: "string" }, d: { type: "string", derived: { a: "x" } } } } },
    }, WS);
    await expect(
      s.applyOp({ op: "replace_object", name: "with_derived", def: { kind: "thing", properties: {} } }, WS)
    ).rejects.toThrow(/含派生字段/);
    // 挂了多个来源
    await s.applyOp({
      op: "import_objects",
      objects: {
        multi_src: {
          kind: "thing",
          identity: "sn",
          properties: { sn: { type: "string" } },
          sources: {
            sa: { connection: "purchase_sys", table: "po_item", fields: { sn: "sn" } },
            sb: { connection: "device_sys", table: "device", fields: { sn: "serial_no" } },
          },
        },
      },
    }, WS);
    await expect(
      s.applyOp({ op: "replace_object", name: "multi_src", def: { kind: "thing", properties: {} } }, WS)
    ).rejects.toThrow(/挂了多个来源/);
    // 有来源且含未对照到表列的字段
    await s.applyOp({
      op: "import_objects",
      objects: {
        unmapped: {
          kind: "thing",
          identity: "sn",
          properties: { sn: { type: "string" }, extra: { type: "string" } },
          sources: { sa: { connection: "purchase_sys", table: "po_item", fields: { sn: "sn" } } },
        },
      },
    }, WS);
    await expect(
      s.applyOp({ op: "replace_object", name: "unmapped", def: { kind: "thing", properties: {} } }, WS)
    ).rejects.toThrow(/含有未对照到表列的字段/);
    // 含动作 / 含公理：import 会剥掉这两个键，走 replaceBlockers 直测（与 applyOp 共用同一函数）
    expect(s.replaceBlockers({ kind: "thing", properties: {}, actions: { a: { effect: [{ link: "x" }] } } }, false)).toEqual(["含动作"]);
    expect(s.replaceBlockers({ kind: "thing", properties: {}, axioms: { x: { type: "mutex", property: "p" } } }, false)).toEqual(["含公理"]);
    // 空 map 在 JS 里为真，不能误锁
    expect(s.replaceBlockers({ kind: "thing", properties: {}, actions: {}, axioms: {} }, false)).toEqual([]);
    // 被拒绝的替换不落地、不留脏
    expect((await s.getDraft(WS)).draft.object_types.equipment.properties.serial_no).toBeDefined();
  });

  it("替换后 match 断了：validateSemantics 整步回退，关系与原类体都在", async () => {
    const s = await freshStore();
    await s.applyOp({
      op: "import_objects",
      objects: {
        po_x: { kind: "thing", identity: "sn", properties: { sn: { type: "string" } }, sources: { sa: { connection: "purchase_sys", table: "po_item", fields: { sn: "sn" } } } },
      },
    }, WS);
    await s.applyOp({ op: "create_link", name: "po_x_eq", from: "po_x", to: "equipment", match: { from: "sn", to: "serial_no" } }, WS);
    // 替换掉 sn 属性 → match 指向不存在的属性 → 整步回退
    await expect(
      s.applyOp({ op: "replace_object", name: "po_x", def: { kind: "thing", properties: { other: { type: "string" } } } }, WS)
    ).rejects.toThrow(/配置不合法/);
    const d = (await s.getDraft(WS)).draft;
    expect(d.object_types.po_x.properties.sn).toBeDefined(); // 原类体还在
    expect(d.link_types.po_x_eq).toBeDefined(); // 关系也没被拆
  });

  it("import_objects / replace_object 的类体剥掉 actions 与 axioms（不报错、不落地）", async () => {
    const s = await freshStore();
    await s.applyOp({
      op: "import_objects",
      objects: {
        stripped: {
          kind: "thing",
          properties: {},
          actions: { a: { effect: [{ link: "x" }] } },
          axioms: { x: { type: "mutex", property: "p" } },
        },
      },
    }, WS);
    const t = (await s.getDraft(WS)).draft.object_types.stripped;
    expect("actions" in t).toBe(false);
    expect("axioms" in t).toBe(false);
    expect(s.replaceBlockers(t, false)).toEqual([]); // 剥干净后可整份替换
  });

  it("base_rev：相等才写入； stale 拒绝且不落地；并发下第二个写入拿到 DraftReject", async () => {
    const s = await freshStore();
    const r0 = s.getRev(WS);
    // 串行：先成功一次（rev +1），再带旧 base_rev 必拒
    await s.applyOp({ op: "create_object", name: "vendor", kind: "thing" }, WS, { base_rev: r0 });
    expect(s.getRev(WS)).toBe(r0 + 1);
    await expect(s.applyOp({ op: "add_property", object: "vendor", name: "v1", type: "string" }, WS, { base_rev: r0 })).rejects.toThrow(/草稿已变/);
    expect((await s.getDraft(WS)).draft.object_types.vendor.properties.v1).toBeUndefined(); // 没落地
    // 并发：p1 先跑完把 rev 推到 r0+2，p2 的 base_rev=r0+1 在 task 开头对不上
    const cur = s.getRev(WS);
    const p1 = s.applyOp({ op: "add_property", object: "vendor", name: "v2", type: "string" }, WS);
    const p2 = s.applyOp({ op: "add_property", object: "vendor", name: "v3", type: "string" }, WS, { base_rev: cur });
    const [r1, r2] = await Promise.allSettled([p1, p2]);
    expect(r1.status).toBe("fulfilled");
    expect(r2.status).toBe("rejected");
    expect((r2 as PromiseRejectedResult).reason.message).toMatch(/草稿已变/);
    const props = (await s.getDraft(WS)).draft.object_types.vendor.properties;
    expect(props.v2).toBeDefined();
    expect(props.v3).toBeUndefined(); // 输的那次不落地
    // base_rev 对上了又能写（队列没被拒绝拖死）
    await s.applyOp({ op: "add_property", object: "vendor", name: "v3", type: "string" }, WS, { base_rev: s.getRev(WS) });
    expect((await s.getDraft(WS)).draft.object_types.vendor.properties.v3).toBeDefined();
  });
});
