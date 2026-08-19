// M4/M6 与 MCP 测试：版本历史与回滚、验收问题集跑批、问数 API 台账、MCP 工具端点。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("版本历史与回滚", () => {
  let tmp: string;
  let repoRoot: string;
  beforeEach(() => {
    repoRoot = process.cwd();
    tmp = mkdtempSync(join(tmpdir(), "ontos-ver-"));
    mkdirSync(join(tmp, "lib/config"), { recursive: true });
    cpSync(join(repoRoot, "lib/config/ontology.yaml"), join(tmp, "lib/config/ontology.yaml"));
    process.chdir(tmp);
  });
  afterEach(async () => {
    (await import("../lib/engine/configStore")).resetStore();
    (await import("../lib/meta/store")).resetMetaStore();
    process.chdir(repoRoot);
    rmSync(tmp, { recursive: true, force: true });
  });

  it("回滚是 revert 语义：v1 内容发成 v3，历史链不断", async () => {
    const s = await import("../lib/engine/configStore");
    s.resetStore();
    await s.applyOp({ op: "create_object", name: "vendor", kind: "thing" });
    await s.publishDraft(); // v2 含 vendor
    expect((await s.getPublished()).version).toBe(2);
    const { version } = await s.rollbackTo(1); // 回到 v1 内容
    expect(version).toBe(3); // 不是回到 v1，是新发一版
    expect((await s.getPublished()).config.object_types.vendor).toBeUndefined();
    expect((await s.listVersions()).map((v) => v.version)).toEqual([1, 2, 3]);
    expect((await s.getDraft()).dirty).toBe(false); // 回滚后草稿与已发布一致
  });
});

describe("验收问题集跑批（真路由）", () => {
  // 直接打 POST /api/questions?run=1，不在测试里重实现跑批；与仓库运行态隔离
  let tmp: string;
  let repoRoot: string;
  beforeEach(async () => {
    repoRoot = process.cwd();
    tmp = mkdtempSync(join(tmpdir(), "ontos-q-"));
    mkdirSync(join(tmp, "lib/config"), { recursive: true });
    cpSync(join(repoRoot, "lib/config/ontology.yaml"), join(tmp, "lib/config/ontology.yaml"));
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

  it("期望行数对上记通过、对不上记失败；失败带明细，版本落上", async () => {
    const meta = (await import("../lib/meta/store")).metaStore();
    const { POST } = await import("../app/api/questions/route");
    await meta.addQuestion("default", "在役设备及其所属部门", "97"); // 种子恰有 97 台在役
    await meta.addQuestion("default", "还有多少在途设备", "1"); // 故意答错（实际 81）
    const res = await POST(new Request("http://x/api/questions?run=1", { method: "POST" }) as never);
    const data = await res.json();
    const pass = data.results.find((r: { question: string }) => r.question === "在役设备及其所属部门");
    const fail = data.results.find((r: { question: string }) => r.question === "还有多少在途设备");
    expect(pass.status).toBe("通过");
    expect(fail.status).toBe("失败");
    expect(fail.detail).toContain("期望 1 行");
    // 状态与版本落库
    const stored = await meta.listQuestions("default");
    expect(stored.find((q) => q.question === "在役设备及其所属部门")?.status).toBe("通过");
    expect(stored.every((q) => q.version === 1)).toBe(true);
  });
});

describe("MCP 工具端点", () => {
  // 路由读 cwd 下的已发布配置与元数据库——拷贝种子到临时目录，与仓库运行态（versions/ 等）隔离
  let tmp: string;
  let repoRoot: string;
  beforeEach(async () => {
    repoRoot = process.cwd();
    tmp = mkdtempSync(join(tmpdir(), "ontos-mcp-"));
    mkdirSync(join(tmp, "lib/config"), { recursive: true });
    cpSync(join(repoRoot, "lib/config/ontology.yaml"), join(tmp, "lib/config/ontology.yaml"));
    process.chdir(tmp);
    // 清掉 globalThis 单例：别的 describe 用过的句柄绑死了旧目录
    const s = await import("../lib/engine/configStore");
    s.resetStore();
    (await import("../lib/meta/store")).resetMetaStore();
    (await import("../lib/engine/load")).resetRegistry(); // fixture 内存库会被 run_action 真改，用例间要全新
  });
  afterEach(async () => {
    const s = await import("../lib/engine/configStore");
    s.resetStore();
    (await import("../lib/meta/store")).resetMetaStore();
    (await import("../lib/engine/load")).resetRegistry();
    process.chdir(repoRoot);
    rmSync(tmp, { recursive: true, force: true });
  });

  /** JSON-RPC 2.0 调用：HTTP 一律 200，成败看信封（result / error）。 */
  async function rpc(method: string, params?: Record<string, unknown>, rawBody?: string) {
    const { POST } = await import("../app/api/mcp/route");
    const req = new Request("http://localhost/api/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: rawBody ?? JSON.stringify({ jsonrpc: "2.0", id: 7, method, params }),
    });
    const res = await POST(req as never);
    return (await res.json()) as { id?: unknown; result?: any; error?: { code: number; message: string } };
  }
  const call = (name: string, args: Record<string, unknown>) => rpc("tools/call", { name, arguments: args });

  it("initialize 握手 + tools/list 列出七个工具 + id 回显", async () => {
    const init = await rpc("initialize");
    expect(init.id).toBe(7);
    expect(init.result.serverInfo.name).toBe("ontos");
    const list = await rpc("tools/list");
    expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual([
      "query",
      "run_action",
      "propose_ontology",
      "propose_action",
      "list_classes",
      "read_class",
      "search",
    ]);
  });

  it("query：执行结构化查询并留痕", async () => {
    const r = await call("query", { query: { object: "equipment", filter: { status: "scrapped" } } });
    expect(r.error).toBeUndefined();
    expect(r.result.structuredContent.rows.length).toBe(3);
  });

  it("run_action：验收一台在途设备", async () => {
    const r = await call("run_action", { action: "convert", object: "equipment", identity: "SN-40217" });
    expect(r.error).toBeUndefined();
    expect(r.result.structuredContent.ok).toBe(true);
    expect(r.result.structuredContent.projections.length).toBe(3);
    expect(r.result.isError).toBeUndefined();
  });

  it("run_action：前置不满足标 isError（与 /api/action 的 422 同语义）", async () => {
    const r = await call("run_action", { action: "convert", object: "equipment", identity: "SN-40080" }); // 已在役，前置不满足
    expect(r.result.structuredContent.ok).toBe(false);
    expect(r.result.isError).toBe(true);
  });

  it("propose_ontology：对表产草稿建议（不落画布）", async () => {
    const r = await call("propose_ontology", { tables: [{ connection: "device_sys", table: "department" }] });
    expect(r.result.structuredContent.object_types.department.properties.dept_name).toBeDefined();
  });

  it("propose_action：有转化关系的类给转化模板", async () => {
    const r = await call("propose_action", { object: "equipment" });
    expect(r.result.structuredContent.action.effect).toEqual([{ link: "converted" }]);
  });

  it("未知工具 -32601；入参形状不合法 -32602；领域拒绝 -32000；坏 JSON -32700", async () => {
    expect((await call("fly", {})).error?.code).toBe(-32601);
    expect((await call("query", { query: { limit: "lots" } })).error?.code).toBe(-32602);
    expect((await call("query", { query: { object: "ghost" } })).error?.code).toBe(-32000);
    expect((await rpc("tools/list", undefined, "not json")).error?.code).toBe(-32700);
  });
});
