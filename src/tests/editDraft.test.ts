// 配置存储测试 —— 工作副本、发布、放弃，以及发布后引擎立即可见。
// 每个用例在独立临时目录里跑：复制种子配置进去，元库（共享 SQLite）从无到有，不污染仓库。
// B 方案：版本链在 onto_version 表里，不再落版本文件——断言直接查库。
// 拆文件：整份替换在 replaceObject.test.ts；动作写入在 actionWrite.test.ts；set_fields 级联在 fieldsUpdate.test.ts。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupRuntime, freshStore, meta, restartRuntime, setupRuntime, unwrap, expectRejected } from "./helpers";
import { Verdict } from "../server/schema/verdict";

// 测试数据（演示模板）在 test 空间，所以配置存储的用例跑在 test 上；default 空白起步。

const WORKSPACE = "test";

let tmp: string;

beforeEach(async () => {
  tmp = await setupRuntime("ontos-store-");
});

afterEach(async () => {
  await cleanupRuntime(tmp);
});

describe("配置存储（工作副本与发布）", () => {
  it("初始：草稿=已发布 v1，无改动", async () => {
    const s = await freshStore(tmp);
    const state = await s.getDraft(WORKSPACE);
    expect(state.baseVersion).toBe(1);
    expect(state.dirty).toBe(false);
    expect(state.draft.object_types.equipment).toBeDefined();
  });

  it("新建对象：进草稿、置 dirty；重名与非法名被拒", async () => {
    const s = await freshStore(tmp);
    await s.editDraft({ op: "create_object", name: "vendor", description: "供应商", kind: "thing" }, WORKSPACE);
    expect((await s.getDraft(WORKSPACE)).dirty).toBe(true);
    expect((await s.getDraft(WORKSPACE)).draft.object_types.vendor.kind).toBe("thing");
    await expectRejected(s.editDraft({ op: "create_object", name: "vendor", kind: "thing" }, WORKSPACE), "类已存在");
    await expectRejected(s.editDraft({ op: "create_object", name: "Vendor", kind: "thing" }, WORKSPACE));
  });

  it("发布后：版本入元库、引擎读到新版、草稿收口；新类可查", async () => {
    const s = await freshStore(tmp);
    await s.editDraft({ op: "create_object", name: "vendor", kind: "thing" }, WORKSPACE);
    await s.editDraft({ op: "add_property", object: "vendor", name: "vendor_no", type: "string" }, WORKSPACE);
    await s.editDraft({ op: "set_identity", object: "vendor", name: "vendor_no" }, WORKSPACE);
    const { version } = unwrap(await s.publish(WORKSPACE));
    expect(version).toBe(2);
    expect((await s.getDraft(WORKSPACE)).dirty).toBe(false);
    expect((await s.getPublished(WORKSPACE)).version).toBe(2);
    expect((await s.getPublished(WORKSPACE)).config.object_types.vendor.identity).toBe("vendor_no");
    expect(await (await meta()).versionYaml(WORKSPACE, 2)).toBeDefined(); // v2 快照在 onto_version
    // 引擎读已发布：新类可查（无源 → 空结果，不报错）
    const { query } = await import("../server/features/query/query");
    const { freshDriver } = await import("../server/infra/fixture");
    const res = unwrap(await query(s.env, (await s.getPublished(WORKSPACE)).config, freshDriver(), { object: "vendor" }));
    expect(res.rows).toEqual([]);
  });

  it("发布不合法配置被拒：识别字段指向不存在的属性", async () => {
    const s = await freshStore(tmp);
    await s.editDraft({ op: "create_object", name: "vendor", kind: "thing" }, WORKSPACE);
    await s.editDraft({ op: "add_property", object: "vendor", name: "vendor_no", type: "string" }, WORKSPACE);
    // 绕过 editDraft 写坏草稿（无状态化后 getDraft 每次水合，必须显式落库），验证发布闸
    const state = await s.getDraft(WORKSPACE);
    state.draft.object_types.vendor.identity = "ghost";
    await (await meta()).saveDraftPack(WORKSPACE, { config: state.draft, layout: state.layout, edgeBends: state.edgeBends, edgePins: state.edgePins }, await s.getRev(WORKSPACE), false);
    await expectRejected(s.publish(WORKSPACE));
  });

  it("update_link：改名/改描述/改反向名；被引用的关系改名被拒", async () => {
    const s = await freshStore(tmp);
    // 未引用关系：建一条再改
    await s.editDraft({ op: "create_link", name: "covers_x", from: "warranty_card", to: "equipment", match: { from: "serial_no", to: "serial_no" } }, WORKSPACE);
    await s.editDraft({ op: "update_link", name: "covers_x", new_name: "covers_y", description: "测试改名", inverse: "covered_by_y" }, WORKSPACE);
    const l = (await s.getDraft(WORKSPACE)).draft.link_types.covers_y;
    expect(l.description).toBe("测试改名");
    expect(l.inverse).toBe("covered_by_y");
    expect((await s.getDraft(WORKSPACE)).draft.link_types.covers_x).toBeUndefined();
    // 不存在 / 撞名 / 非法名
    await expectRejected(s.editDraft({ op: "update_link", name: "ghost" }, WORKSPACE), "关系不存在");
    await expectRejected(s.editDraft({ op: "update_link", name: "covers_y", new_name: "belongs_to" }, WORKSPACE), "已存在");
    await expectRejected(s.editDraft({ op: "update_link", name: "covers_y", new_name: "Bad Name" }, WORKSPACE));
    // 被引用：converted 被 convert 动作的效应引用，改名被拒
    await expectRejected(s.editDraft({ op: "update_link", name: "converted", new_name: "converted2" }, WORKSPACE), /仍被引用/);
    // 空串清掉描述与反向名
    await s.editDraft({ op: "update_link", name: "covers_y", description: "", inverse: "" }, WORKSPACE);
    const l2 = (await s.getDraft(WORKSPACE)).draft.link_types.covers_y;
    expect(l2.description).toBeUndefined();
    expect(l2.inverse).toBeUndefined();
  });

  it("update_property：改说明/类型/枚举值/改名；被引用改名被拒；唯一键指针跟随", async () => {
    const s = await freshStore(tmp);
    // 改类型 + 枚举值
    await s.editDraft({ op: "update_property", object: "equipment", name: "name", type: "enum", values: ["a", "b"] }, WORKSPACE);
    const p1 = (await s.getDraft(WORKSPACE)).draft.object_types.equipment.properties.name;
    expect(p1.type).toBe("enum");
    expect(p1.values).toEqual(["a", "b"]);
    // 类型离开 enum：枚举值跟着清掉
    await s.editDraft({ op: "update_property", object: "equipment", name: "name", type: "string" }, WORKSPACE);
    expect((await s.getDraft(WORKSPACE)).draft.object_types.equipment.properties.name.values).toBeUndefined();
    // 改说明与空串清掉
    await s.editDraft({ op: "update_property", object: "equipment", name: "name", description: "设备名称" }, WORKSPACE);
    expect((await s.getDraft(WORKSPACE)).draft.object_types.equipment.properties.name.description).toBe("设备名称");
    await s.editDraft({ op: "update_property", object: "equipment", name: "name", description: "" }, WORKSPACE);
    expect((await s.getDraft(WORKSPACE)).draft.object_types.equipment.properties.name.description).toBeUndefined();
    // 不存在被拒
    await expectRejected(s.editDraft({ op: "update_property", object: "equipment", name: "ghost", description: "x" }, WORKSPACE), "字段不存在");
    // equipment.name 被源映射引用 → 改名被拒
    await expectRejected(s.editDraft({ op: "update_property", object: "equipment", name: "name", new_name: "dev_name" }, WORKSPACE), /仍被引用/);
    // 手工对象的字段改名成功 + 唯一键指针跟随
    await s.editDraft({ op: "create_object", name: "vendor", kind: "thing" }, WORKSPACE);
    await s.editDraft({ op: "add_property", object: "vendor", name: "vendor_no", type: "string" }, WORKSPACE);
    await s.editDraft({ op: "set_identity", object: "vendor", name: "vendor_no" }, WORKSPACE);
    await s.editDraft({ op: "update_property", object: "vendor", name: "vendor_no", new_name: "vendor_code" }, WORKSPACE);
    const v = (await s.getDraft(WORKSPACE)).draft.object_types.vendor;
    expect(v.properties.vendor_no).toBeUndefined();
    expect(v.properties.vendor_code).toBeDefined();
    expect(v.identity).toBe("vendor_code");
    await expectRejected(s.editDraft({ op: "update_property", object: "vendor", name: "vendor_code", new_name: "Bad Name" }, WORKSPACE));
  });

  it("放弃：草稿回退到已发布快照", async () => {
    const s = await freshStore(tmp);
    await s.editDraft({ op: "create_object", name: "vendor", kind: "thing" }, WORKSPACE);
    expect((await s.getDraft(WORKSPACE)).dirty).toBe(true);
    await s.discard(WORKSPACE);
    const state = await s.getDraft(WORKSPACE);
    expect(state.dirty).toBe(false);
    expect(state.draft.object_types.vendor).toBeUndefined();
  });

  it("rev：内容变更 +1；摆位也 +1（界面状态写同样走 CAS）；放弃后变且不为 0；干净草稿上回滚也 +1", async () => {
    const s = await freshStore(tmp);
    expect(await s.getRev(WORKSPACE)).toBe(0);
    await s.editDraft({ op: "create_object", name: "vendor", kind: "thing" }, WORKSPACE);
    expect(await s.getRev(WORKSPACE)).toBe(1);
    await s.editDraft({ op: "save_layout", positions: { vendor: { x: 1, y: 2 } } }, WORKSPACE);
    expect(await s.getRev(WORKSPACE)).toBe(2); // 摆位写也 bump：界面状态写与内容写互相 CAS 检测
    const before = await s.getRev(WORKSPACE);
    await s.discard(WORKSPACE);
    expect(await s.getRev(WORKSPACE)).toBe(before + 1); // 放弃也 +1：草稿内容变了（且永远不归零）
    expect(await s.getRev(WORKSPACE)).not.toBe(0);
    // 干净草稿（rev 可能为正）上回滚也 +1——监视器按相等比较，少了这拍另一标签页会漏刷新
    await s.rollbackTo(1, WORKSPACE);
    expect(await s.getRev(WORKSPACE)).toBe(before + 2);
  });

  it("拒绝后续链：前一次 DraftReject 之后，后续写入仍成功", async () => {
    const s = await freshStore(tmp);
    await expectRejected(s.editDraft({ op: "create_object", name: "equipment", kind: "thing" }, WORKSPACE), "类已存在");
    await s.editDraft({ op: "create_object", name: "vendor", kind: "thing" }, WORKSPACE); // 不能被上一次拒绝拖死
    expect((await s.getDraft(WORKSPACE)).draft.object_types.vendor).toBeDefined();
  });

  it("编辑操作守卫：删识别字段被拒；派生属性不能当识别字段；摆位不置 dirty", async () => {
    const s = await freshStore(tmp);
    await expectRejected(s.editDraft({ op: "remove_property", object: "equipment", name: "serial_no" }, WORKSPACE), "唯一键不能直接删");
    await expectRejected(s.editDraft({ op: "set_identity", object: "equipment", name: "status" }, WORKSPACE), "派生字段");
    await s.editDraft({ op: "save_layout", positions: { equipment: { x: 10, y: 20 } } }, WORKSPACE);
    expect((await s.getDraft(WORKSPACE)).dirty).toBe(false);
    expect((await s.getDraft(WORKSPACE)).layout.equipment).toEqual({ x: 10, y: 20 });
  });

  it("发布后状态比较不受键序影响（zod parse 会重排键）", async () => {
    const s = await freshStore(tmp);
    await s.editDraft({ op: "create_object", name: "vendor", kind: "thing" }, WORKSPACE);
    await s.editDraft({ op: "add_property", object: "vendor", name: "vendor_no", type: "string" }, WORKSPACE);
    await s.editDraft({ op: "set_identity", object: "vendor", name: "vendor_no" }, WORKSPACE);
    await s.publish(WORKSPACE);
    // zod parse 后键序不同，但结构比较应判 same
    expect(s.sameConfig((await s.getPublished(WORKSPACE)).config.object_types.vendor, (await s.getDraft(WORKSPACE)).draft.object_types.vendor)).toBe(true);
  });

  it("重启路径：发布后清内存，从元库版本链读回 v2", async () => {
    const s = await freshStore(tmp);
    await s.editDraft({ op: "create_object", name: "vendor", kind: "thing" }, WORKSPACE);
    await s.publish(WORKSPACE);
    await restartRuntime(tmp); // 模拟重启：内存态清空
    expect((await s.getPublished(WORKSPACE)).version).toBe(2);
    expect((await s.getPublished(WORKSPACE)).config.object_types.vendor).toBeDefined();
  });

  it("未发布的编辑只进工作行（canvas_json）不落 YAML；重启后工作副本还在，版本链仍是 v1", async () => {
    const s = await freshStore(tmp);
    await s.editDraft({ op: "create_object", name: "vendor", kind: "thing" }, WORKSPACE);
    const store = await meta();
    const saved = await store.getDraftPack(WORKSPACE);
    expect(saved).toBeDefined();
    expect(JSON.stringify(saved)).toContain("vendor");
    expect((saved as { pack: { config: unknown } }).pack.config).toBeDefined(); // pack 里是 config 对象，不是 YAML 文本
    expect(await store.versionYaml(WORKSPACE, 2)).toBeUndefined(); // 没点发布，没有 v2 YAML
    await restartRuntime(tmp);
    const state = await s.getDraft(WORKSPACE);
    expect(state.dirty).toBe(true);
    expect(state.draft.object_types.vendor).toBeDefined();
    expect((await s.getPublished(WORKSPACE)).version).toBe(1);
    expect((await s.getPublished(WORKSPACE)).config.object_types.vendor).toBeUndefined();
  });

  it("发布把画布 JSON 存进该版；回到这版连摆位一起覆盖", async () => {
    const s = await freshStore(tmp);
    const store = await meta();
    await s.editDraft({ op: "create_object", name: "vendor", kind: "thing" }, WORKSPACE);
    await s.editDraft({ op: "add_property", object: "vendor", name: "vendor_no", type: "string" }, WORKSPACE);
    await s.editDraft({ op: "set_identity", object: "vendor", name: "vendor_no" }, WORKSPACE);
    await s.editDraft({ op: "save_layout", positions: { vendor: { x: 11, y: 22 } } }, WORKSPACE);
    await s.publish(WORKSPACE);
    const snap = await store.versionCanvas(WORKSPACE, 2);
    expect(JSON.stringify(snap)).toContain("vendor");
    expect((snap as { layout: { vendor: { x: number; y: number } } }).layout.vendor).toEqual({ x: 11, y: 22 });

    await s.editDraft({ op: "create_object", name: "ghost", kind: "thing" }, WORKSPACE);
    await s.editDraft({ op: "save_layout", positions: { vendor: { x: 99, y: 99 } } }, WORKSPACE);
    await s.rollbackTo(2, WORKSPACE);
    expect((await s.getPublished(WORKSPACE)).version).toBe(2);
    expect((await s.getDraft(WORKSPACE)).draft.object_types.ghost).toBeUndefined();
    expect((await s.getDraft(WORKSPACE)).layout.vendor).toEqual({ x: 11, y: 22 });
    expect((await s.getDraft(WORKSPACE)).dirty).toBe(false);
  });

  it("发布把工作行复制成编号行（YAML 进版本链）；放弃把工作行写回已发布内容", async () => {
    const s = await freshStore(tmp);
    const store = await meta();
    await s.editDraft({ op: "create_object", name: "vendor", kind: "thing" }, WORKSPACE);
    await s.editDraft({ op: "add_property", object: "vendor", name: "vendor_no", type: "string" }, WORKSPACE);
    await s.editDraft({ op: "set_identity", object: "vendor", name: "vendor_no" }, WORKSPACE);
    expect(JSON.stringify(await store.getDraftPack(WORKSPACE))).toContain("vendor");
    await s.publish(WORKSPACE);
    expect(await store.versionYaml(WORKSPACE, 2)).toMatch(/vendor:/); // 发布才有 YAML
    // 工作行永存：发布后内容与已发布一致（可变头 = 最新内容）
    expect(JSON.stringify(await store.getDraftPack(WORKSPACE))).toContain("vendor");
    expect((await s.getDraft(WORKSPACE)).dirty).toBe(false);

    await s.editDraft({ op: "create_object", name: "ghost", kind: "thing" }, WORKSPACE);
    expect(JSON.stringify(await store.getDraftPack(WORKSPACE))).toContain("ghost");
    await s.discard(WORKSPACE);
    expect(JSON.stringify(await store.getDraftPack(WORKSPACE))).not.toContain("ghost");
    await restartRuntime(tmp);
    expect((await s.getDraft(WORKSPACE)).draft.object_types.ghost).toBeUndefined();
    expect((await s.getDraft(WORKSPACE)).dirty).toBe(false);
  });

  it("未知操作被拒，不置 dirty", async () => {
    const s = await freshStore(tmp);
    await expectRejected(s.editDraft({ op: "fly_to_moon" } as never, WORKSPACE), "未知操作");
    expect((await s.getDraft(WORKSPACE)).dirty).toBe(false);
  });

  it("识别字段可取消（空串）；改出去又改回来 dirty 能收回", async () => {
    const s = await freshStore(tmp);
    // 有源类取消识别字段就没有认行依据——校验闸拒绝（无源对象才可无 identity）
    await expectRejected(s.editDraft({ op: "set_identity", object: "equipment", name: "" }, WORKSPACE), "认行依据");
    expect((await s.getDraft(WORKSPACE)).dirty).toBe(false); // 被拒的操作不留痕
    await s.editDraft({ op: "set_identity", object: "equipment", name: "name" }, WORKSPACE);
    expect((await s.getDraft(WORKSPACE)).dirty).toBe(true);
    await s.editDraft({ op: "set_identity", object: "equipment", name: "serial_no" }, WORKSPACE); // 改回去
    expect((await s.getDraft(WORKSPACE)).dirty).toBe(false);
  });

  it("删被引用的属性被拒，并报出引用处", async () => {
    const s = await freshStore(tmp);
    await expectRejected(s.editDraft({ op: "remove_property", object: "equipment", name: "mark" }, WORKSPACE), "仍被引用");
  });

  it("手动连线：建关系、删关系；重名与配对字段不存在被拒；被引用的关系删不掉", async () => {
    const s = await freshStore(tmp);
    await s.editDraft({ op: "create_link", name: "located_in", from: "equipment", to: "department", match: { from: "dept", to: "dept_id" }, card: "n:1" }, WORKSPACE);
    expect((await s.getDraft(WORKSPACE)).draft.link_types.located_in.match).toEqual([{ from: "dept", to: "dept_id" }]);
    expect((await s.getDraft(WORKSPACE)).dirty).toBe(true);
    // 重名拒绝
    await expectRejected(s.editDraft({ op: "create_link", name: "located_in", from: "equipment", to: "department", match: { from: "dept", to: "dept_id" } }, WORKSPACE), "已存在");
    // 配对字段不存在拒绝
    await expectRejected(s.editDraft({ op: "create_link", name: "bad_link", from: "equipment", to: "department", match: { from: "ghost", to: "dept_id" } }, WORKSPACE), "没有字段");
    // 端点不存在拒绝
    await expectRejected(s.editDraft({ op: "create_link", name: "bad2", from: "equipment", to: "ghost", match: { from: "dept", to: "x" } }, WORKSPACE), "类不存在");
    // 被动作引用的转化关系删不掉
    await expectRejected(s.editDraft({ op: "delete_link", name: "converted" }, WORKSPACE), "仍被引用");
    // 普通关系能删
    await s.editDraft({ op: "delete_link", name: "located_in" }, WORKSPACE);
    expect((await s.getDraft(WORKSPACE)).draft.link_types.located_in).toBeUndefined();
  });

  it("无改动发布是空操作：版本不变、不入库", async () => {
    const s = await freshStore(tmp);
    const { version } = unwrap(await s.publish(WORKSPACE));
    expect(version).toBe(1);
    expect(await (await meta()).versionYaml(WORKSPACE, 2)).toBeUndefined(); // 没有 v2
  });

  it("导入整批原子：半途撞名不留下前几个类", async () => {
    const s = await freshStore(tmp);
    // 第二个类撞已存在的 equipment：整批应拒绝，draft 里不能留下 vendor_ok
    await expectRejected(
      s.editDraft(
        {
          op: "import_objects",
          objects: {
            vendor_ok: { kind: "thing", properties: {} },
            equipment: { kind: "thing", properties: {} }, // 撞名
          },
        },
        WORKSPACE
      )
,"类已存在");
    expect((await s.getDraft(WORKSPACE)).draft.object_types.vendor_ok).toBeUndefined(); // 没有部分应用
    expect((await s.getDraft(WORKSPACE)).dirty).toBe(false);
    // 非法类名同样整批拒
    await expectRejected(s.editDraft({ op: "import_objects", objects: { Bad_Name: { kind: "thing", properties: {} } } }, WORKSPACE), "类名");
    expect((await s.getDraft(WORKSPACE)).draft.object_types.Bad_Name).toBeUndefined();
  });

  it("放弃草稿：未绑版本的裁决留痕标「已放弃」，不挂到下一次发布", async () => {
    const s = await freshStore(tmp);
    const m = await meta();
    await s.editDraft({ op: "create_object", name: "vendor", kind: "thing" }, WORKSPACE);
    await m.recordDecision(WORKSPACE, { class_a: "a", class_b: "b", source_a: "s1", source_b: "s2", verdict: Verdict.Skip, decided_by: "测试" });
    await s.discard(WORKSPACE);
    expect((await m.listDecisions(WORKSPACE))[0].version).toBe(-1); // 已放弃
    // 下一次发布不回填它
    await s.editDraft({ op: "create_object", name: "vendor2", kind: "thing" }, WORKSPACE);
    await s.publish(WORKSPACE);
    expect((await m.listDecisions(WORKSPACE))[0].version).toBe(-1);
  });

  it("跨类动作引用守卫：删 repair.is_open 被拒（equipment.finish_repair 在用）", async () => {
    const s = await freshStore(tmp);
    await expectRejected(s.editDraft({ op: "remove_property", object: "repair", name: "is_open" }, WORKSPACE), "仍被引用");
    await expectRejected(s.editDraft({ op: "remove_property", object: "repair", name: "is_open" }, WORKSPACE), "finish_repair");
  });

  it("发布闸拦动作里的坏引用：效应指向不存在的类", async () => {
    const s = await freshStore(tmp);
    await s.editDraft({ op: "create_object", name: "vendor", kind: "thing" }, WORKSPACE); // 先产生合法改动，置 dirty
    const state = await s.getDraft(WORKSPACE);
    state.draft.object_types.equipment.actions!.bad = {
      effect: [{ update: { object: "ghost_class", filter: { x: 1 }, properties: { y: 2 } } }],
    };
    await (await meta()).saveDraftPack(WORKSPACE, { config: state.draft, layout: state.layout, edgeBends: state.edgeBends, edgePins: state.edgePins }, await s.getRev(WORKSPACE), false);
    await expectRejected(s.publish(WORKSPACE), "不存在的类");
  });
});
