// set_fields：导入自动生成与级联测试
// 从 editDraft.test.ts 拆出：同一运行态纪律（每用例一份干净内存态，test 空间跑演示模板数据）。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupRuntime, freshStore, setupRuntime, unwrap, expectRejected } from "./helpers";

const WORKSPACE = "test";

let tmp: string;

beforeEach(async () => {
  tmp = await setupRuntime("ontos-fields-");
});

afterEach(async () => {
  await cleanupRuntime(tmp);
});

describe("set_fields：导入自动生成与级联", () => {
  // 造类：identity + props，源条目挂在 conn 上；unmapped 里的属性不进 fields（不映射），extraProps 直接并入
  function mkCls(identity: string, props: string[], conn: string, opts: { unmapped?: string[]; extraProps?: Record<string, object> } = {}) {
    const all: Record<string, object> = { [identity]: { type: "string" } };
    for (const p of props) all[p] = { type: "string" };
    Object.assign(all, opts.extraProps ?? {});
    const unmapped = new Set(opts.unmapped ?? []);
    const fields = Object.fromEntries(Object.entries(all).filter(([k, v]) => !unmapped.has(k) && !("derived" in v)).map(([k]) => [k, k]));
    return { kind: "thing", identity, properties: all, sources: { [conn]: { connection: conn, table: `${conn}_t`, pk: identity, fields } } };
  }
  const updatePropsOf = (cls: Record<string, any>) => cls.actions?.set_fields?.effect?.[0]?.update?.properties as Record<string, unknown> | undefined;

  it("导入即带 set_fields：唯一键与派生属性不可写；发布过闸", async () => {
    const s = await freshStore(tmp);
    await s.editDraft(
      { op: "import_objects", objects: { dev_auto: mkCls("sn", ["name", "weight"], "cauto", { extraProps: { status: { type: "string", derived: [{ when: { cauto: true }, value: "active" }] } } }) } },
      WORKSPACE
    );
    const dev = (await s.getDraft(WORKSPACE)).draft.object_types.dev_auto;
    expect(dev.actions?.set_fields?.description).toBe("更新字段（导入时自动生成）");
    expect(updatePropsOf(dev)).toEqual({ name: { from: "request" }, weight: { from: "request" } }); // sn 唯一键、status 派生，不进
    expect((await s.publish(WORKSPACE)).code).toBe(200); // 空前置过发布闸
  });

  it("无可写字段（只有唯一键）不生成", async () => {
    const s = await freshStore(tmp);
    await s.editDraft({ op: "import_objects", objects: { tag_only: mkCls("code", [], "ctag") } }, WORKSPACE);
    expect((await s.getDraft(WORKSPACE)).draft.object_types.tag_only.actions).toBeUndefined();
  });

  it("字段改名：set_fields 的键跟着走，发布不炸", async () => {
    const s = await freshStore(tmp);
    await s.editDraft({ op: "import_objects", objects: { dev_ren: mkCls("sn", ["note"], "cren", { unmapped: ["note"] }) } }, WORKSPACE);
    await s.editDraft({ op: "update_property", object: "dev_ren", name: "note", new_name: "remark" }, WORKSPACE);
    const dev = (await s.getDraft(WORKSPACE)).draft.object_types.dev_ren;
    expect(updatePropsOf(dev)).toEqual({ remark: { from: "request" } });
    expect((await s.publish(WORKSPACE)).code).toBe(200);
  });

  it("字段删除：set_fields 摘键；摘空了整条动作撤掉", async () => {
    const s = await freshStore(tmp);
    await s.editDraft(
      { op: "import_objects", objects: { dev_del: mkCls("sn", ["note", "color"], "cdel", { unmapped: ["note"] }), dev_empty: mkCls("sn", ["note"], "cemp", { unmapped: ["note"] }) } },
      WORKSPACE
    );
    await s.editDraft({ op: "remove_property", object: "dev_del", name: "note" }, WORKSPACE);
    expect(updatePropsOf((await s.getDraft(WORKSPACE)).draft.object_types.dev_del)).toEqual({ color: { from: "request" } });
    await s.editDraft({ op: "remove_property", object: "dev_empty", name: "note" }, WORKSPACE);
    expect((await s.getDraft(WORKSPACE)).draft.object_types.dev_empty.actions).toBeUndefined(); // 摘空 → 整条撤
    expect((await s.publish(WORKSPACE)).code).toBe(200);
  });

  it("源映射的引用仍然拦改名与删除（豁免的只有 set_fields）", async () => {
    const s = await freshStore(tmp);
    await s.editDraft({ op: "import_objects", objects: { dev_map: mkCls("sn", ["note"], "cmap") } }, WORKSPACE); // note 进了 fields
    await expectRejected(s.editDraft({ op: "update_property", object: "dev_map", name: "note", new_name: "remark" }, WORKSPACE), /仍被引用/);
    await expectRejected(s.editDraft({ op: "remove_property", object: "dev_map", name: "note" }, WORKSPACE), /仍被引用/);
  });

  it("部分重叠：公共属性挪到上位对象，两类的 set_fields 摘键", async () => {
    const s = await freshStore(tmp);
    await s.editDraft({ op: "import_objects", objects: { pa: mkCls("a_no", ["name", "a_only"], "ca"), pb: mkCls("b_no", ["name", "b_only"], "cb") } }, WORKSPACE);
    const { decide } = await import("../server/features/integrate/decide");
    const { Verdict } = await import("../server/schema/verdict");
    await decide(s.env, { class_a: "pa", class_b: "pb", verdict: Verdict.Overlap }, WORKSPACE);
    const d = (await s.getDraft(WORKSPACE)).draft;
    expect(d.object_types.shared_pa_pb).toBeDefined();
    expect(updatePropsOf(d.object_types.pa as never)).toEqual({ a_only: { from: "request" } });
    expect(updatePropsOf(d.object_types.pb as never)).toEqual({ b_only: { from: "request" } });
    expect((await s.publish(WORKSPACE)).code).toBe(200);
  });

  it("同一：留下类的 set_fields 不吸收并入属性，被并类的动作随之消失", async () => {
    const s = await freshStore(tmp);
    await s.editDraft({ op: "import_objects", objects: { sa: mkCls("x", ["p1"], "csa"), sb: mkCls("x", ["p2"], "csb") } }, WORKSPACE);
    const { decide } = await import("../server/features/integrate/decide");
    const { Verdict } = await import("../server/schema/verdict");
    await decide(s.env, { class_a: "sa", class_b: "sb", verdict: Verdict.Same }, WORKSPACE);
    const d = (await s.getDraft(WORKSPACE)).draft;
    expect(d.object_types.sb).toBeUndefined();
    expect(d.object_types.sa.properties.p2).toBeDefined(); // 属性并进了留下类
    expect(updatePropsOf(d.object_types.sa as never)).toEqual({ p1: { from: "request" } }); // 但动作清单不吸收，留给人补
    expect((await s.publish(WORKSPACE)).code).toBe(200);
  });
});
