// 工作空间隔离：两个空间各自一套配置与元数据，互不干扰；台账路由的列表/新建/拒绝。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
    // default 建对象并发布 → v2
    s.applyOp({ op: "create_object", name: "vendor", kind: "thing" }, "default");
    expect(s.publishDraft("default").version).toBe(2);
    // lab 首次访问：从模板播种，v1，没有 vendor
    expect(s.getPublished("lab").version).toBe(1);
    expect(s.getPublished("lab").config.object_types.vendor).toBeUndefined();
    // lab 自己发布：default 的版本与内容都不受影响
    s.applyOp({ op: "create_object", name: "person_x", kind: "thing" }, "lab");
    expect(s.publishDraft("lab").version).toBe(2);
    expect(s.getPublished("default").version).toBe(2);
    expect(s.getPublished("default").config.object_types.person_x).toBeUndefined();
    // 版本文件分属两个空间目录
    expect(existsSync(join(tmp, "lib/config/workspaces/default/versions/v2.yaml"))).toBe(true);
    expect(existsSync(join(tmp, "lib/config/workspaces/lab/versions/v2.yaml"))).toBe(true);
  });

  it("元数据库也是两个：一个空间留痕不进另一个", async () => {
    const meta = await import("../lib/meta/store");
    meta.metaStore("default").recordDecision({ class_a: "a", class_b: "b", source_a: "s1", source_b: "s2", verdict: "跳过", decided_by: "测试" });
    expect(meta.metaStore("default").listDecisions().length).toBe(1);
    expect(meta.metaStore("lab").listDecisions().length).toBe(0);
    expect(existsSync(join(tmp, "lib/config/workspaces/default/ontos-meta.db"))).toBe(true);
    expect(existsSync(join(tmp, "lib/config/workspaces/lab/ontos-meta.db"))).toBe(true);
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
