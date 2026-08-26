// 动作写入（set_action / remove_action）与动作形状四查测试
// 从 editDraft.test.ts 拆出：同一运行态纪律（每用例一份干净内存态，test 空间跑演示模板数据）。

import { dump } from "js-yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupRuntime, freshStore, meta, restartRuntime, setupRuntime, unwrap, expectRejected } from "./helpers";
import { Verdict } from "../server/schema/verdict";

const WORKSPACE = "test";

let tmp: string;

beforeEach(async () => {
  tmp = await setupRuntime("ontos-actw-");
});

afterEach(async () => {
  await cleanupRuntime(tmp);
});

describe("动作写入（set_action / remove_action）与动作形状四查", () => {
  const renameDef = { description: "改名", effect: [{ update: { object: "vendor", identity: { from: "identity" }, properties: { vendor_no: { from: "request" } } } }] };

  it("set_action 新增/同名覆盖；remove_action 删除；删最后一个动作后 actions 键消失", async () => {
    const s = await freshStore(tmp);
    await s.editDraft({ op: "create_object", name: "vendor", kind: "thing" }, WORKSPACE);
    await s.editDraft({ op: "add_property", object: "vendor", name: "vendor_no", type: "string" }, WORKSPACE);
    // 新增
    await s.editDraft({ op: "set_action", object: "vendor", name: "rename", def: renameDef }, WORKSPACE);
    expect((await s.getDraft(WORKSPACE)).draft.object_types.vendor.actions!.rename.description).toBe("改名");
    // 同名覆盖（与画布编辑同权）
    await s.editDraft({ op: "set_action", object: "vendor", name: "rename", def: { ...renameDef, description: "改名单" } }, WORKSPACE);
    expect((await s.getDraft(WORKSPACE)).draft.object_types.vendor.actions!.rename.description).toBe("改名单");
    // 删除
    await s.editDraft({ op: "remove_action", object: "vendor", name: "rename" }, WORKSPACE);
    const t = (await s.getDraft(WORKSPACE)).draft.object_types.vendor;
    expect("actions" in t).toBe(false); // 空 map 不留：sameConfig 才能收回 dirty
    // 再删一次 → 动作不存在
    await expectRejected(s.editDraft({ op: "remove_action", object: "vendor", name: "rename" }, WORKSPACE), "动作不存在");
    // set_action 到不存在的类 → 类不存在
    await expectRejected(s.editDraft({ op: "set_action", object: "ghost", name: "a", def: renameDef }, WORKSPACE), "类不存在");
  });

  it("对已发布类 set_action 再 remove_action 还原后 dirty 收回", async () => {
    const s = await freshStore(tmp);
    await s.editDraft({ op: "set_action", object: "equipment", name: "temp_act", def: { effect: [{ update: { object: "equipment", identity: { from: "identity" }, properties: { dept: { from: "request" } } } }] } }, WORKSPACE);
    expect((await s.getDraft(WORKSPACE)).dirty).toBe(true);
    await s.editDraft({ op: "remove_action", object: "equipment", name: "temp_act" }, WORKSPACE);
    expect((await s.getDraft(WORKSPACE)).dirty).toBe(false); // 改出去又改回来，dirty 收得回
  });

  it("效应 link 指向不存在或非转化关系：整步回退", async () => {
    const s = await freshStore(tmp);
    await expectRejected(
      s.editDraft({ op: "set_action", object: "equipment", name: "bad", def: { effect: [{ link: "ghost_link" }] } }, WORKSPACE)
,/不存在的转化关系/);
    // match 关系不是转化关系，同样拦
    await s.editDraft({ op: "create_link", name: "eq_self", from: "equipment", to: "equipment", match: { from: "serial_no", to: "serial_no" } }, WORKSPACE);
    await expectRejected(
      s.editDraft({ op: "set_action", object: "equipment", name: "bad", def: { effect: [{ link: "eq_self" }] } }, WORKSPACE)
,/不存在的转化关系/);
    expect((await s.getDraft(WORKSPACE)).draft.object_types.equipment.actions!.bad).toBeUndefined();
  });

  it("删掉转化关系的唯一引用动作被拦，message 带逃生指引；先写替代动作就能删", async () => {
    const s = await freshStore(tmp);
    await expectRejected(s.editDraft({ op: "remove_action", object: "equipment", name: "convert" }, WORKSPACE), /先写一条同样 link 该转化关系的替代动作，再删旧的/);
    // 逃生路径：先 set_action 一条同样 link converted 的替代动作，再删 convert
    await s.editDraft({ op: "set_action", object: "equipment", name: "convert_v2", def: { description: "替代", pre: { status: "in_transit" }, effect: [{ link: "converted" }] } }, WORKSPACE);
    await s.editDraft({ op: "remove_action", object: "equipment", name: "convert" }, WORKSPACE);
    expect((await s.getDraft(WORKSPACE)).draft.object_types.equipment.actions!.convert).toBeUndefined();
    expect((await s.getDraft(WORKSPACE)).draft.object_types.equipment.actions!.convert_v2).toBeDefined();
  });

  it("认人必须写明：update/delete 缺 identity 与 filter 被拒；非法取值来源被拒", async () => {
    const s = await freshStore(tmp);
    await expectRejected(
      s.editDraft({ op: "set_action", object: "equipment", name: "bad", def: { effect: [{ update: { object: "equipment", properties: { dept: "x" } } }] } }, WORKSPACE)
,/缺 identity 或 filter/);
    await expectRejected(
      s.editDraft({ op: "set_action", object: "equipment", name: "bad", def: { effect: [{ delete: { object: "equipment" } }] } }, WORKSPACE)
,/缺 identity 或 filter/);
    // from: generated 不许用在 update（只许 create 且目标属性带 generate）
    await expectRejected(
      s.editDraft({ op: "set_action", object: "equipment", name: "bad", def: { effect: [{ update: { object: "equipment", identity: { from: "identity" }, properties: { dept: { from: "generated" } } } }] } }, WORKSPACE)
,/from: generated/);
    // create 没有 current 上下文
    await expectRejected(
      s.editDraft({ op: "set_action", object: "equipment", name: "bad", def: { effect: [{ create: { object: "warranty_card", properties: { serial_no: { from: "current" } } } }] } }, WORKSPACE)
,/current/);
    // 不认识的取值来源
    await expectRejected(
      s.editDraft({ op: "set_action", object: "equipment", name: "bad", def: { effect: [{ update: { object: "equipment", identity: { from: "identity" }, properties: { dept: { from: "yesterday" } } } }] } }, WORKSPACE)
,/取值来源不认识/);
  });

  it("set_action 之后再 replace_object 被「含动作」锁拒", async () => {
    const s = await freshStore(tmp);
    await s.editDraft({ op: "create_object", name: "vendor", kind: "thing" }, WORKSPACE);
    await s.editDraft({ op: "add_property", object: "vendor", name: "vendor_no", type: "string" }, WORKSPACE);
    await s.editDraft({ op: "set_action", object: "vendor", name: "rename", def: renameDef }, WORKSPACE);
    await expectRejected(s.editDraft({ op: "replace_object", name: "vendor", def: { kind: "thing", properties: {} } }, WORKSPACE), /含动作/);
  });

  it("先阶段后合并的多跳裁决不炸：转化动作随被吸收类的转化关系一起消亡（不复制）", async () => {
    const s = await freshStore(tmp);
    const { adjudicate } = await import("../server/features/integrate/applyVerdict");
    await s.editDraft({
      op: "import_objects",
      objects: {
        eq_a: { kind: "thing", identity: "sn", properties: { sn: { type: "string" } }, sources: { sa: { connection: "purchase_sys", table: "po_item", fields: { sn: "sn" } } } },
        eq_b: { kind: "thing", identity: "serial_no", properties: { serial_no: { type: "string" } }, sources: { sb: { connection: "device_sys", table: "device", fields: { serial_no: "serial_no" } } } },
        main: { kind: "thing", identity: "sn2", properties: { sn2: { type: "string" } }, sources: { sc: { connection: "asset_sys", table: "asset", fields: { sn2: "sn" } } } },
      },
    }, WORKSPACE);
    // 先「阶段」：eq_b 并进 eq_a，产出转化关系 eq_a_to_在役 + 转化动作 convert_to_在役
    await adjudicate(s.env, { class_a: "eq_a", class_b: "eq_b" }, Verdict.Stage, { from: "在途", to: "在役" }, WORKSPACE);
    expect((await s.getDraft(WORKSPACE)).draft.object_types.eq_a.actions!.convert_to_在役).toBeDefined();
    // 再「同一」：eq_a 并进 main——convert_to_在役 引用将随 eq_a 消亡的转化关系，必须跳过不复制
    await adjudicate(s.env, { class_a: "main", class_b: "eq_a" }, Verdict.Same, undefined, WORKSPACE);
    const d = (await s.getDraft(WORKSPACE)).draft;
    expect(d.object_types.eq_a).toBeUndefined();
    expect(d.link_types.eq_a_to_在役).toBeUndefined();
    expect(d.object_types.main.actions?.convert_to_在役).toBeUndefined(); // 没跟过来：跟过来会被校验①整步回退
    expect(d.object_types.main.properties.status).toBeDefined(); // 派生阶段正常并入
  });

  it("B 的动作引用 B 自身（set_fields 效应 object:B、pre 过滤 remapId）：随 B 消亡不搬进 A，裁决落地不弹回", async () => {
    const s = await freshStore(tmp);
    const { adjudicate } = await import("../server/features/integrate/applyVerdict");
    // main2 只有唯一键（无 set_fields）；aux 有可写字段（带 set_fields）且 identity 与 main2 不同名（remapId = serial_no）
    await s.editDraft(
      {
        op: "import_objects",
        objects: {
          main2: { kind: "thing", identity: "sn", properties: { sn: { type: "string" }, note: { type: "string" } }, sources: { sa: { connection: "purchase_sys", table: "po_item", fields: { sn: "sn" } } } },
          aux: {
            kind: "thing",
            identity: "serial_no",
            properties: { serial_no: { type: "string" }, color: { type: "string" } },
            sources: { sb: { connection: "device_sys", table: "device", fields: { serial_no: "serial_no", color: "name" } } },
          },
        },
      },
      WORKSPACE
    );
    // aux 再带两条自定义动作：recolor 效应 object: aux（指向 dying 类）且 pre 过滤 serial_no（remapId 键）；
    // notify_x 的 inform 对象是 aux（告知对象指向 dying 类）
    await s.editDraft(
      { op: "set_action", object: "aux", name: "recolor", def: { pre: { serial_no: "SN-1" }, effect: [{ update: { object: "aux", identity: { from: "identity" }, properties: { color: { from: "request" } } } }] } },
      WORKSPACE
    );
    await s.editDraft(
      { op: "set_action", object: "aux", name: "notify_x", def: { effect: [{ update: { object: "main2", identity: { from: "identity" }, properties: { note: { from: "request" } } } }], inform: [{ object: "aux", to: ["payroll"], properties: { c: { from: "request" } } }] } },
      WORKSPACE
    );
    await adjudicate(s.env, { class_a: "main2", class_b: "aux" }, Verdict.Same, undefined, WORKSPACE);
    const d = (await s.getDraft(WORKSPACE)).draft;
    expect(d.object_types.aux).toBeUndefined();
    expect(d.object_types.main2.properties.color).toBeDefined(); // 属性正常并入
    // main2 自己的 set_fields 留着（效应 object: main2）；aux 的 set_fields（object: aux）撞名跳过+随类消亡，没盖掉它
    expect(d.object_types.main2.actions?.set_fields?.effect).toEqual([{ update: { object: "main2", identity: { from: "identity" }, properties: { note: { from: "request" } } } }]);
    // 旧守护只防垂死关系：recolor（效应 object: aux、pre 读写 remapId）会搬进 main2 → 校验炸、裁决整步回退
    expect(d.object_types.main2.actions?.recolor).toBeUndefined();
    expect(d.object_types.main2.actions?.notify_x).toBeUndefined(); // inform 对象是 dying 类：同样随类消亡
    expect((await s.publish(WORKSPACE)).code).toBe(200); // 关键断言：落地，不弹回
  });

  it("历史已发布配置违反动作形状校验也能加载（getPublished 不查）；但草稿写入会拦", async () => {
    const s = await freshStore(tmp);
    // 手工塞一个 v2：转化关系 orphan_tr 没有任何动作引用（② 违例）
    const bad = structuredClone((await s.getPublished(WORKSPACE)).config);
    bad.link_types.orphan_tr = { from: "equipment", to: "equipment", transition: { property: "status", from: "in_transit", to: "in_service" } };
    await (await meta()).insertVersion(WORKSPACE, 2, dump(bad, { lineWidth: 120, noRefs: true }), "publish");
    await restartRuntime(tmp);
    const p = await s.getPublished(WORKSPACE); // 加载放行：validateSemantics 跑、validateActionShapes 不跑
    expect(p.version).toBe(2);
    expect(p.config.link_types.orphan_tr).toBeDefined();
    // 但草稿路径被拦：任何一步写入都会因孤儿转化关系整步回退（再回滚到合法版本才恢复）
    await expectRejected(s.editDraft({ op: "create_object", name: "vendor", kind: "thing" }, WORKSPACE), /orphan_tr/);
  });
});
