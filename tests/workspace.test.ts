// 工作空间隔离（B 方案）：共享元库 + workspace_id。两个空间各自一条版本链、各自一份元数据，
// 互不干扰；台账路由的列表/新建/拒绝。每个用例在独立临时目录里跑，元库文件从无到有。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmp: string;
let repoRoot: string;

beforeEach(async () => {
  repoRoot = process.cwd();
  tmp = mkdtempSync(join(tmpdir(), "ontos-ws-"));
  mkdirSync(join(tmp, "lib/config"), { recursive: true });
  cpSync(join(repoRoot, "lib/config/ontology.yaml"), join(tmp, "lib/config/ontology.yaml")); // 种子模板
  process.chdir(tmp);
  (await import("../lib/engine/configStore")).resetStore();
  (await import("../lib/meta/store")).resetMetaStore();
  (await import("../lib/engine/load")).resetRegistry();
});
afterEach(async () => {
  (await import("../lib/engine/configStore")).resetStore();
  (await import("../lib/meta/store")).resetMetaStore();
  (await import("../lib/engine/load")).resetRegistry();
  process.chdir(repoRoot);
  rmSync(tmp, { recursive: true, force: true });
});

describe("空间隔离", () => {
  it("两个空间各自发布升级，互不干扰；首次访问自动从模板播种", async () => {
    const s = await import("../lib/engine/configStore");
    const meta = (await import("../lib/meta/store")).metaStore();
    // default 建对象并发布 → v2
    await s.applyOp({ op: "create_object", name: "vendor", kind: "thing" }, "default");
    expect((await s.publishDraft("default")).version).toBe(2);
    // lab 首次访问：从模板播种，v1，没有 vendor
    expect((await s.getPublished("lab")).version).toBe(1);
    expect((await s.getPublished("lab")).config.object_types.vendor).toBeUndefined();
    // lab 自己发布：default 的版本与内容都不受影响
    await s.applyOp({ op: "create_object", name: "person_x", kind: "thing" }, "lab");
    expect((await s.publishDraft("lab")).version).toBe(2);
    expect((await s.getPublished("default")).version).toBe(2);
    expect((await s.getPublished("default")).config.object_types.person_x).toBeUndefined();
    // 版本链在同一元库里按 workspace_id 分开：两个空间各有自己的 v2
    expect(await meta.versionYaml("default", 2)).toBeDefined();
    expect(await meta.versionYaml("lab", 2)).toBeDefined();
    expect((await meta.listVersions("default")).map((v) => v.version)).toEqual([1, 2]);
    expect((await meta.listVersions("lab")).map((v) => v.version)).toEqual([1, 2]);
  });

  it("元数据按 workspace_id 隔离：一个空间留痕不进另一个", async () => {
    const meta = (await import("../lib/meta/store")).metaStore();
    await meta.recordDecision("default", { class_a: "a", class_b: "b", source_a: "s1", source_b: "s2", verdict: "跳过", decided_by: "测试" });
    expect((await meta.listDecisions("default")).length).toBe(1);
    expect((await meta.listDecisions("lab")).length).toBe(0);
    // 发号器也按空间分开：同名序列各自从 1 起
    expect(await meta.nextSeq("default", "eq")).toBe(1);
    expect(await meta.nextSeq("default", "eq")).toBe(2);
    expect(await meta.nextSeq("lab", "eq")).toBe(1);
  });

  it("摆位按空间分开存（onto_workspace.layout）", async () => {
    const s = await import("../lib/engine/configStore");
    await s.applyOp({ op: "save_layout", positions: { equipment: { x: 1, y: 2 } } }, "default");
    expect((await s.getDraft("default")).layout.equipment).toEqual({ x: 1, y: 2 });
    expect((await s.getDraft("lab")).layout.equipment).toBeUndefined();
  });
});

describe("workspaces 路由", () => {
  const post = (name: string) =>
    import("../app/api/workspaces/route").then(({ POST }) =>
      POST(new Request("http://x/api/workspaces", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }) }) as never)
    );

  it("列表含 default；新建成功；重名 422；非法名 422", async () => {
    const { GET } = await import("../app/api/workspaces/route");
    const list = await (await GET()).json();
    expect(list.workspaces).toContain("default");
    const ok = await post("lab2");
    expect(ok.status).toBe(200);
    expect((await ok.json()).workspaces).toContain("lab2");
    expect((await post("lab2")).status).toBe(422); // 重名
    expect((await post("Bad Name")).status).toBe(422); // 非法名
  });
});
