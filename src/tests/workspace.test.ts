// 工作空间隔离（B 方案）：共享元库 + workspace_id。两个空间各自一条版本链、各自一份元数据，
// 互不干扰；台账路由的列表/新建/拒绝。每个用例在独立临时目录里跑，元库文件从无到有。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupRuntime, draftEngine, setupRuntime } from "./helpers";
import { Verdict } from "../server/engine/adjudication/verdict";

let tmp: string;

beforeEach(async () => {
  tmp = await setupRuntime("ontos-ws-");
});
afterEach(async () => {
  await cleanupRuntime(tmp);
});

describe("空间隔离", () => {
  it("两个空间各自发布升级，互不干扰；新空间与 default 空白起步，演示模板与 fixture 只属于 test", async () => {
    const s = await draftEngine();
    const meta = (await import("../server/meta/store")).metaStore();
    // default 建对象并发布 → v2
    await s.editDraft({ op: "create_object", name: "vendor", kind: "thing" }, "default");
    expect((await s.publish("default")).version).toBe(2);
    // lab 首次访问：空白起步（v1、空本体）；default 也空白起步（没有模板类）——模板只属于 test
    expect((await s.getPublished("lab")).version).toBe(1);
    expect(Object.keys((await s.getPublished("lab")).config.object_types)).toEqual([]);
    expect((await s.getPublished("default")).config.object_types.equipment).toBeUndefined();
    expect((await s.getPublished("test")).config.object_types.equipment).toBeDefined();
    // fixture 连接只注入 test：default 空白起步，数据源自己接
    const { getDriverRegistry } = await import("../server/engine/infra/connections");
    expect((await getDriverRegistry("test")).connectionNames()).toContain("purchase_sys");
    expect((await getDriverRegistry("default")).connectionNames()).toEqual([]);
    // lab 自己发布：default 的版本与内容都不受影响
    await s.editDraft({ op: "create_object", name: "person_x", kind: "thing" }, "lab");
    expect((await s.publish("lab")).version).toBe(2);
    expect((await s.getPublished("default")).version).toBe(2);
    expect((await s.getPublished("default")).config.object_types.person_x).toBeUndefined();
    // 版本链在同一元库里按 workspace_id 分开：两个空间各有自己的 v2
    expect(await meta.versionYaml("default", 2)).toBeDefined();
    expect(await meta.versionYaml("lab", 2)).toBeDefined();
    expect((await meta.listVersions("default")).map((v) => v.version)).toEqual([1, 2]);
    expect((await meta.listVersions("lab")).map((v) => v.version)).toEqual([1, 2]);
  });

  it("元数据按 workspace_id 隔离：一个空间留痕不进另一个", async () => {
    const meta = (await import("../server/meta/store")).metaStore();
    await meta.recordDecision("default", { class_a: "a", class_b: "b", source_a: "s1", source_b: "s2", verdict: Verdict.Skip, decided_by: "测试" });
    expect((await meta.listDecisions("default")).length).toBe(1);
    expect((await meta.listDecisions("lab")).length).toBe(0);
    // 发号器也按空间分开：同名序列各自从 1 起
    expect(await meta.nextSeq("default", "eq")).toBe(1);
    expect(await meta.nextSeq("default", "eq")).toBe(2);
    expect(await meta.nextSeq("lab", "eq")).toBe(1);
  });

  it("摆位按空间分开存（onto_version 的工作行）", async () => {
    const s = await draftEngine();
    await s.editDraft({ op: "save_layout", positions: { equipment: { x: 1, y: 2 } } }, "default");
    expect((await s.getDraft("default")).layout.equipment).toEqual({ x: 1, y: 2 });
    expect((await s.getDraft("lab")).layout.equipment).toBeUndefined();
  });
});

describe("workspaces 路由", () => {
  const post = (name: string) =>
    import("../app/api/workspaces/route").then(({ POST }) =>
      POST(new Request("http://x/api/workspaces", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) }) as never)
    );

  it("列表含 default 与 test；新建成功；重名 422；非法名 422", async () => {
    const { GET } = await import("../app/api/workspaces/route");
    const list = await (await GET()).json();
    expect(list.workspaces).toContain("default");
    expect(list.workspaces).toContain("test"); // 测试空间常驻列表（首次访问才注册）
    const ok = await post("lab2");
    expect(ok.status).toBe(200);
    expect((await ok.json()).workspaces).toContain("lab2");
    expect((await post("lab2")).status).toBe(422); // 重名
    expect((await post("Bad Name")).status).toBe(422); // 非法名
  });
});
