// 整份替换（replace_object）与 base_rev 测试
// 从 editDraft.test.ts 拆出：同一运行态纪律（每用例一份干净内存态，test 空间跑演示模板数据）。

import { replaceBlockers } from "../server/features/ontology/ops/replaceObject";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupRuntime, freshStore, setupRuntime, unwrap, expectRejected } from "./helpers";

const WORKSPACE = "test";

let tmp: string;

beforeEach(async () => {
  tmp = await setupRuntime("ontos-replace-");
});

afterEach(async () => {
  await cleanupRuntime(tmp);
});

describe("整份替换（replace_object）与 base_rev", () => {
  it("未锁定类可整份替换：关系与摆位保留；无源的残缺生成（有字段）也能换", async () => {
    const s = await freshStore(tmp);
    // 无源类 + 人手加的字段（后写赢：整份替换会盖掉，不视为锁定）
    await s.editDraft({ op: "create_object", name: "vendor", kind: "thing", description: "旧描述" }, WORKSPACE);
    await s.editDraft({ op: "add_property", object: "vendor", name: "vendor_no", type: "string" }, WORKSPACE);
    await s.editDraft({ op: "create_link", name: "vendor_sells", from: "vendor", to: "equipment", match: { from: "vendor_no", to: "serial_no" } }, WORKSPACE);
    const def = { kind: "thing" as const, description: "新描述", identity: "vendor_no", properties: { vendor_no: { type: "string" as const }, vendor_name: { type: "string" as const } } };
    await s.editDraft({ op: "replace_object", name: "vendor", def }, WORKSPACE);
    const d = (await s.getDraft(WORKSPACE)).draft;
    expect(d.object_types.vendor.description).toBe("新描述");
    expect(d.object_types.vendor.identity).toBe("vendor_no");
    expect(d.object_types.vendor.properties.vendor_name).toBeDefined();
    expect(d.link_types.vendor_sells).toBeDefined(); // 关系不随替换消失
  });

  it("类不存在：replace_object 拒绝并指向 import_objects", async () => {
    const s = await freshStore(tmp);
    await expectRejected(s.editDraft({ op: "replace_object", name: "ghost", def: { kind: "thing", properties: {} } }, WORKSPACE), "新建请用 import_objects");
  });

  it("锁定规则：已发布 / 派生 / 多源 / 有源未对照字段 各拒一次；动作与公理走 replaceBlockers 直测；空 map 不误锁", async () => {
    const s = await freshStore(tmp);
    // 已发布过的类
    await expectRejected(
      s.editDraft({ op: "replace_object", name: "equipment", def: { kind: "thing", properties: {} } }, WORKSPACE)
,/不能整对象替换：已经发布过/);
    // 含派生字段（无源类：不触发未对照字段锁，钉的是派生这一条）
    await s.editDraft({
      op: "import_objects",
      objects: { with_derived: { kind: "thing", properties: { a: { type: "string" }, d: { type: "string", derived: { a: "x" } } } } },
    }, WORKSPACE);
    await expectRejected(
      s.editDraft({ op: "replace_object", name: "with_derived", def: { kind: "thing", properties: {} } }, WORKSPACE)
,/含派生字段/);
    // 挂了多个来源
    await s.editDraft({
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
    }, WORKSPACE);
    await expectRejected(
      s.editDraft({ op: "replace_object", name: "multi_src", def: { kind: "thing", properties: {} } }, WORKSPACE)
,/挂了多个来源/);
    // 有来源且含未对照到表列的字段
    await s.editDraft({
      op: "import_objects",
      objects: {
        unmapped: {
          kind: "thing",
          identity: "sn",
          properties: { sn: { type: "string" }, extra: { type: "string" } },
          sources: { sa: { connection: "purchase_sys", table: "po_item", fields: { sn: "sn" } } },
        },
      },
    }, WORKSPACE);
    await expectRejected(
      s.editDraft({ op: "replace_object", name: "unmapped", def: { kind: "thing", properties: {} } }, WORKSPACE)
,/含有未对照到表列的字段/);
    // 含动作 / 含公理：import 会剥掉这两个键，走 replaceBlockers 直测（与 editDraft 共用同一函数）
    expect(replaceBlockers({ kind: "thing", properties: {}, actions: { a: { effect: [{ link: "x" }] } } }, false)).toEqual(["含动作"]);
    expect(replaceBlockers({ kind: "thing", properties: {}, axioms: { x: { type: "mutex", property: "p" } } }, false)).toEqual(["含公理"]);
    // 空 map 在 JS 里为真，不能误锁
    expect(replaceBlockers({ kind: "thing", properties: {}, actions: {}, axioms: {} }, false)).toEqual([]);
    // 被拒绝的替换不落地、不留脏
    expect((await s.getDraft(WORKSPACE)).draft.object_types.equipment.properties.serial_no).toBeDefined();
  });

  it("替换后 match 断了：validateSemantics 整步回退，关系与原类体都在", async () => {
    const s = await freshStore(tmp);
    await s.editDraft({
      op: "import_objects",
      objects: {
        po_x: { kind: "thing", identity: "sn", properties: { sn: { type: "string" } }, sources: { sa: { connection: "purchase_sys", table: "po_item", fields: { sn: "sn" } } } },
      },
    }, WORKSPACE);
    await s.editDraft({ op: "create_link", name: "po_x_eq", from: "po_x", to: "equipment", match: { from: "sn", to: "serial_no" } }, WORKSPACE);
    // 替换掉 sn 属性 → match 指向不存在的属性 → 整步回退
    await expectRejected(
      s.editDraft({ op: "replace_object", name: "po_x", def: { kind: "thing", properties: { other: { type: "string" } } } }, WORKSPACE)
,/配置不合法/);
    const d = (await s.getDraft(WORKSPACE)).draft;
    expect(d.object_types.po_x.properties.sn).toBeDefined(); // 原类体还在
    expect(d.link_types.po_x_eq).toBeDefined(); // 关系也没被拆
  });

  it("import_objects / replace_object 的类体剥掉 actions 与 axioms（不报错、不落地）", async () => {
    const s = await freshStore(tmp);
    await s.editDraft({
      op: "import_objects",
      objects: {
        stripped: {
          kind: "thing",
          properties: {},
          actions: { a: { effect: [{ link: "x" }] } },
          axioms: { x: { type: "mutex", property: "p" } },
        },
      },
    }, WORKSPACE);
    const t = (await s.getDraft(WORKSPACE)).draft.object_types.stripped;
    expect("actions" in t).toBe(false);
    expect("axioms" in t).toBe(false);
    expect(replaceBlockers(t, false)).toEqual([]); // 剥干净后可整份替换
  });

  it("base_rev：相等才写入； stale 拒绝且不落地；并发下第二个写入拿到 DraftReject", async () => {
    const s = await freshStore(tmp);
    const r0 = await s.getRev(WORKSPACE);
    // 串行：先成功一次（rev +1），再带旧 base_rev 必拒
    await s.editDraft({ op: "create_object", name: "vendor", kind: "thing" }, WORKSPACE, { base_rev: r0 });
    expect(await s.getRev(WORKSPACE)).toBe(r0 + 1);
    await expectRejected(s.editDraft({ op: "add_property", object: "vendor", name: "v1", type: "string" }, WORKSPACE, { base_rev: r0 }),/草稿已变/);
    expect((await s.getDraft(WORKSPACE)).draft.object_types.vendor.properties.v1).toBeUndefined(); // 没落地
    // 并发：两个都带 base_rev=cur（MCP 语义，均不重试）——CAS 恰好一个赢、一个 422「草稿已变」
    const cur = await s.getRev(WORKSPACE);
    const p1 = s.editDraft({ op: "add_property", object: "vendor", name: "v2", type: "string" }, WORKSPACE, { base_rev: cur });
    const p2 = s.editDraft({ op: "add_property", object: "vendor", name: "v3", type: "string" }, WORKSPACE, { base_rev: cur });
    const [r1, r2] = await Promise.all([p1, p2]);
    const codes = [r1.code, r2.code].sort();
    expect(codes).toEqual([200, 422]); // 一个成功一个冲突（CAS 赢家不固定，断言集合）
    const loser = r1.code === 200 ? r2 : r1;
    expect(loser.message).toMatch(/草稿已变/);
    const winnerProp = r1.code === 200 ? "v2" : "v3";
    const props = (await s.getDraft(WORKSPACE)).draft.object_types.vendor.properties;
    expect(props[winnerProp]).toBeDefined(); // 赢的那次落地
    expect(props[winnerProp === "v2" ? "v3" : "v2"]).toBeUndefined(); // 输的那次不落地
    // base_rev 对上了又能写（队列没被拒绝拖死）
    await s.editDraft({ op: "add_property", object: "vendor", name: "v3", type: "string" }, WORKSPACE, { base_rev: await s.getRev(WORKSPACE) });
    expect((await s.getDraft(WORKSPACE)).draft.object_types.vendor.properties.v3).toBeDefined();
  });
});
