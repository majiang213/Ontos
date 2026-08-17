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
  afterEach(() => {
    process.chdir(repoRoot);
    rmSync(tmp, { recursive: true, force: true });
  });

  it("回滚是 revert 语义：v1 内容发成 v3，历史链不断", async () => {
    const s = await import("../lib/engine/configStore");
    s.resetStore();
    s.applyOp({ op: "create_object", name: "vendor", kind: "thing" });
    s.publishDraft(); // v2 含 vendor
    expect(s.getPublished().version).toBe(2);
    const { version } = s.rollbackTo(1); // 回到 v1 内容
    expect(version).toBe(3); // 不是回到 v1，是新发一版
    expect(s.getPublished().config.object_types.vendor).toBeUndefined();
    expect(s.listVersions().map((v) => v.version)).toEqual([1, 2, 3]);
    expect(s.getDraft().dirty).toBe(false); // 回滚后草稿与已发布一致
  });
});

describe("验收问题集跑批（路由同款链路）", () => {
  it("四问全过；答错记失败", async () => {
    const meta = (await import("../lib/meta/store")).freshMetaStore(join(mkdtempSync(join(tmpdir(), "ontos-q-")), "m.db"));
    const { CannedSlot } = await import("../lib/engine/llmSlot");
    const { runQuery } = await import("../lib/engine/query");
    const { freshDriver, loadConfig } = await import("../lib/engine/load");
    const slot = new CannedSlot();
    const config = loadConfig();
    meta.addQuestion("在役设备及其所属部门");
    meta.addQuestion("还有多少在途设备");
    meta.addQuestion("哪些设备过保了");
    meta.addQuestion("每个部门多少台在役设备");
    for (const q of meta.listQuestions()) {
      const query = await slot.nlToQuery(q.question, config);
      await runQuery(config, freshDriver(), query);
      meta.setQuestionStatus(q.id, "通过", 1);
    }
    expect(meta.listQuestions().every((q) => q.status === "通过")).toBe(true);
    meta.close();
  });
});

describe("MCP 工具端点", () => {
  async function call(name: string, args: Record<string, unknown>) {
    const { POST } = await import("../app/api/mcp/route");
    const req = new Request("http://localhost/api/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ method: "tools/call", params: { name, arguments: args } }),
    });
    const res = await POST(req as never);
    return { status: res.status, data: await res.json() };
  }

  it("tools/list 列出四个工具", async () => {
    const { POST } = await import("../app/api/mcp/route");
    const res = await POST(new Request("http://x", { method: "POST", body: JSON.stringify({ method: "tools/list" }) }) as never);
    const data = await res.json();
    expect(data.tools.map((t: { name: string }) => t.name)).toEqual(["query", "run_action", "propose_ontology", "propose_action"]);
  });

  it("query：执行结构化查询并留痕", async () => {
    const { status, data } = await call("query", { query: { object: "equipment", filter: { status: "scrapped" } } });
    expect(status).toBe(200);
    expect(data.content.rows.length).toBe(3);
  });

  it("run_action：验收一台在途设备", async () => {
    const { status, data } = await call("run_action", { action: "convert", object: "equipment", identity: "SN-40217" });
    expect(status).toBe(200);
    expect(data.content.ok).toBe(true);
    expect(data.content.projections.length).toBe(3);
  });

  it("propose_ontology：对表产草稿建议（不落画布）", async () => {
    const { status, data } = await call("propose_ontology", { tables: [{ connection: "device_sys", table: "department" }] });
    expect(status).toBe(200);
    expect(data.content.object_types.department.properties.dept_name).toBeDefined();
  });

  it("propose_action：有转化关系的类给转化模板", async () => {
    const { status, data } = await call("propose_action", { object: "equipment" });
    expect(status).toBe(200);
    expect(data.content.action.effect).toEqual([{ link: "converted" }]);
  });

  it("未知工具 400；入参形状不合法 400；名字对不上 422", async () => {
    expect((await call("fly", {})).status).toBe(400);
    expect((await call("query", { query: { limit: "lots" } })).status).toBe(400);
    expect((await call("query", { query: { object: "ghost" } })).status).toBe(422);
  });
});
