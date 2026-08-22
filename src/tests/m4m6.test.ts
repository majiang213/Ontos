// M4/M6 与 MCP 测试：版本历史与回滚、验收问题集跑批、MCP 工具端点。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupRuntime, restartRuntime, setupRuntime } from "./helpers";

describe("版本历史与回滚", () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await setupRuntime("ontos-ver-");
  });
  afterEach(async () => {
    await cleanupRuntime(tmp);
  });

  it("回滚是 revert 语义：v1 内容发成 v3，历史链不断", async () => {
    const s = await import("../server/engine/configStore");
    await restartRuntime(tmp); // 从干净内存态开始
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
  beforeEach(async () => {
    tmp = await setupRuntime("ontos-q-");
  });
  afterEach(async () => {
    await cleanupRuntime(tmp);
  });

  it("期望行数对上记通过、对不上记失败；失败带明细，版本落上", async () => {
    const meta = (await import("../server/meta/store")).metaStore();
    const { POST } = await import("../app/api/questions/route");
    await meta.addQuestion("test", "在役设备及其所属部门", "97"); // 种子恰有 97 台在役
    await meta.addQuestion("test", "还有多少在途设备", "1"); // 故意答错（实际 81）
    const res = await POST(new Request("http://x/api/questions?ws=test&run=1", { method: "POST" }) as never);
    const data = await res.json();
    const pass = data.results.find((r: { question: string }) => r.question === "在役设备及其所属部门");
    const fail = data.results.find((r: { question: string }) => r.question === "还有多少在途设备");
    expect(pass.status).toBe("通过");
    expect(fail.status).toBe("失败");
    expect(fail.detail).toContain("期望 1 行");
    // 状态与版本落库
    const stored = await meta.listQuestions("test");
    expect(stored.find((q) => q.question === "在役设备及其所属部门")?.status).toBe("通过");
    expect(stored.every((q) => q.version === 1)).toBe(true);
  });
});

describe("MCP 工具端点", () => {
  // 路由读运行态 cwd 下的已发布配置与元数据库——每用例一个临时目录 + 全新运行态，与仓库运行态隔离
  let tmp: string;
  beforeEach(async () => {
    tmp = await setupRuntime("ontos-mcp-"); // fixture 内存库会被 run_action 真改，用例间要全新
  });
  afterEach(async () => {
    await cleanupRuntime(tmp);
  });

  /** JSON-RPC 2.0 调用：HTTP 一律 200，成败看信封（result / error）。测试数据在 test 空间。 */
  async function rpc(method: string, params?: Record<string, unknown>, rawBody?: string, headers?: Record<string, string>) {
    const { POST } = await import("../app/api/mcp/route");
    const req = new Request("http://localhost/api/mcp?ws=test", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: rawBody ?? JSON.stringify({ jsonrpc: "2.0", id: 7, method, params }),
    });
    const res = await POST(req as never);
    return (await res.json()) as { id?: unknown; result?: any; error?: { code: number; message: string } };
  }
  const call = (name: string, args: Record<string, unknown>, headers?: Record<string, string>) => rpc("tools/call", { name, arguments: args }, undefined, headers);

  it("initialize 握手 + tools/list 列出九个工具（顺序钉死）+ id 回显", async () => {
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
      "list_tables",
      "apply_draft",
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

  it("run_action：前置不满足标 isError（业务失败与信封错误分开）", async () => {
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

  it("发现工具说明点明已发布/草稿；space 非法值 -32602；query/run_action/propose_ontology 不接受 space", async () => {
    const list = await rpc("tools/list");
    const descOf = (n: string) => list.result.tools.find((t: { name: string }) => t.name === n).description as string;
    for (const n of ["list_classes", "read_class", "search", "propose_action"]) {
      expect(descOf(n)).toMatch(/已发布|草稿/); // 钉死：说明必须点明两个世界，防回归成「全部的类」
    }
    expect((await call("list_classes", { space: "Draft" })).error?.code).toBe(-32602);
    expect((await call("search", { text: "设备", space: "working" })).error?.code).toBe(-32602);
    expect((await call("query", { query: { object: "equipment" }, space: "draft" })).error?.code).toBe(-32602);
    expect((await call("run_action", { action: "convert", object: "equipment", identity: "SN-40217", space: "draft" })).error?.code).toBe(-32602);
    expect((await call("propose_ontology", { tables: [{ connection: "device_sys", table: "department" }], space: "draft" })).error?.code).toBe(-32602);
  });

  it("space=draft 看见未发布类（带状态与 rev）；缺省看不见；query/propose_action 不受草稿影响", async () => {
    const s = await import("../server/engine/configStore");
    await s.applyOp({ op: "create_object", name: "vendor", description: "供应商", kind: "thing" }, "test");
    // 缺省已发布：看不见 vendor
    const pub = await call("list_classes", {});
    expect(pub.result.structuredContent.classes.map((c: { name: string }) => c.name)).not.toContain("vendor");
    // 草稿：看得见，带 state / dirty / rev / base_version
    const d = await call("list_classes", { space: "draft" });
    const sc = d.result.structuredContent;
    expect(sc.space).toBe("draft");
    expect(sc.dirty).toBe(true);
    expect(sc.rev).toBe(s.getRev("test"));
    expect(sc.base_version).toBe(1);
    expect(sc.classes.find((c: { name: string }) => c.name === "vendor").state).toBe("new");
    expect(sc.classes.find((c: { name: string }) => c.name === "equipment").state).toBe("same");
    // read_class 草稿视图带来源对照；已发布视图不带
    const rd = await call("read_class", { name: "equipment", space: "draft" });
    expect(rd.result.structuredContent.state).toBe("same");
    expect(rd.result.structuredContent.sources.length).toBeGreaterThan(0);
    expect(rd.result.structuredContent.sources[0].connection).toBeDefined();
    expect((await call("read_class", { name: "equipment" })).result.structuredContent.sources).toBeUndefined();
    // search 草稿里能搜到新类；缺省搜不到
    expect((await call("search", { text: "供应商", space: "draft" })).result.structuredContent.classes).toContain("vendor");
    expect((await call("search", { text: "供应商" })).result.structuredContent.classes).not.toContain("vendor");
    // query 仍只读已发布：未发布类查不到
    expect((await call("query", { query: { object: "vendor" } })).error?.code).toBe(-32000);
    // propose_action 缺省在已发布里找（草稿新类找不到）；space=draft 找得到
    expect((await call("propose_action", { object: "vendor" })).error?.code).toBe(-32000);
    expect((await call("propose_action", { object: "vendor", space: "draft" })).result.structuredContent.action).toBeDefined();
  });

  it("apply_draft 的 inputSchema：存在、不含 save_layout、base_rev 必填；list_tables/apply_draft 不接受 space", async () => {
    const list = await rpc("tools/list");
    const ad = list.result.tools.find((t: { name: string }) => t.name === "apply_draft");
    expect(ad.inputSchema).toBeDefined();
    expect(JSON.stringify(ad.inputSchema)).not.toContain("save_layout");
    expect(ad.inputSchema.required).toContain("base_rev");
    expect((await call("apply_draft", { op: "create_object", name: "vendor", kind: "thing", base_rev: 0, space: "draft" })).error?.code).toBe(-32602);
    expect((await call("list_tables", { space: "draft" })).error?.code).toBe(-32602);
  });

  it("apply_draft：信封校验（缺 base_rev / 字符串 base_rev）-32602；save_layout -32602", async () => {
    expect((await call("apply_draft", { op: "create_object", name: "vendor", kind: "thing" })).error?.code).toBe(-32602); // 缺 base_rev
    expect((await call("apply_draft", { op: "create_object", name: "vendor", kind: "thing", base_rev: "12" })).error?.code).toBe(-32602); // 字符串不行
    expect((await call("apply_draft", { op: "save_layout", positions: {}, base_rev: 0 })).error?.code).toBe(-32602); // 摆位不在 MCP 联合里
    expect((await call("apply_draft", { op: "fly", base_rev: 0 })).error?.code).toBe(-32602); // 未知 op
  });

  it("apply_draft：ONTOS_TOKEN 设了之后无令牌 -32001，有令牌放行", async () => {
    process.env.ONTOS_TOKEN = "t0ken";
    try {
      expect((await call("apply_draft", { op: "create_object", name: "vendor", kind: "thing", base_rev: 0 })).error?.code).toBe(-32001);
      const ok = await call("apply_draft", { op: "create_object", name: "vendor", kind: "thing", base_rev: 0 }, { authorization: "Bearer t0ken" });
      expect(ok.error).toBeUndefined();
      expect(ok.result.structuredContent.ok).toBe(true);
    } finally {
      delete process.env.ONTOS_TOKEN;
    }
  });

  it("apply_draft 完整往返：读 rev → 写入 ok 且 rev+1 → 重放 stale base_rev 得 -32000 → query 仍读旧已发布", async () => {
    const s = await import("../server/engine/configStore");
    const list = await call("list_classes", { space: "draft" });
    const rev = list.result.structuredContent.rev as number;
    expect(rev).toBe(s.getRev("test"));
    // 落地 import_objects（propose_ontology 的落地点）
    const imp = await call("apply_draft", {
      op: "import_objects",
      objects: { vendor: { kind: "thing", description: "供应商", identity: "vendor_no", properties: { vendor_no: { type: "string" } } } },
      base_rev: rev,
    });
    expect(imp.error).toBeUndefined();
    expect(imp.result.structuredContent).toMatchObject({ ok: true, dirty: true, rev: rev + 1, base_version: 1, op: "import_objects", names: ["vendor"] });
    // 逐步 op：base_rev 跟上后成功，rev 再 +1，names 收类名
    const add = await call("apply_draft", { op: "add_property", object: "vendor", name: "vendor_name", type: "string", base_rev: rev + 1 });
    expect(add.result.structuredContent).toMatchObject({ ok: true, rev: rev + 2, names: ["vendor"] });
    // 重放同一个 stale base_rev → DraftReject → -32000，且不落地
    const replay = await call("apply_draft", { op: "add_property", object: "vendor", name: "ghost_prop", type: "string", base_rev: rev + 1 });
    expect(replay.error?.code).toBe(-32000);
    expect(replay.error?.message).toMatch(/草稿已变/);
    expect((await s.getDraft("test")).draft.object_types.vendor.properties.ghost_prop).toBeUndefined();
    // query 仍只读已发布：未发布的 vendor 查不到
    expect((await call("query", { query: { object: "vendor" } })).error?.code).toBe(-32000);
    // 撞名 → -32000；锁定的整份替换（已发布类）→ -32000 带白话原因
    expect((await call("apply_draft", { op: "import_objects", objects: { vendor: { kind: "thing", properties: {} } }, base_rev: s.getRev("test") })).error?.code).toBe(-32000);
    const lock = await call("apply_draft", { op: "replace_object", name: "equipment", def: { kind: "thing", properties: {} }, base_rev: s.getRev("test") });
    expect(lock.error?.code).toBe(-32000);
    expect(lock.error?.message).toMatch(/不能整对象替换：已经发布过/);
    // 已发布类的草稿视图：replaceable=false 且带原因
    const rc = await call("read_class", { name: "equipment", space: "draft" });
    expect(rc.result.structuredContent.replaceable).toBe(false);
    expect(rc.result.structuredContent.replace_blockers.length).toBeGreaterThan(0);
    // 未锁定的草稿新类：replaceable=true
    const rv = await call("read_class", { name: "vendor", space: "draft" });
    expect(rv.result.structuredContent.replaceable).toBe(true);
    // list_classes 草稿视图带 outlets（test 空间种子有 payroll）
    expect((await call("list_classes", { space: "draft" })).result.structuredContent.outlets).toContain("payroll");
  });

  it("list_tables：列定义无采样行；按连接过滤；未知连接名收在槽内 error", async () => {
    const all = await call("list_tables", {});
    const sources = all.result.structuredContent.sources as { connection: string; tables: { name: string; columns: Record<string, unknown>[] }[] }[];
    expect(sources.length).toBe(4); // test 空间四个 fixture 连接
    const device = sources.find((s) => s.connection === "device_sys");
    expect(device?.tables.length).toBeGreaterThan(0);
    const deviceTable = device?.tables.find((t) => t.name === "device");
    expect(deviceTable?.columns[0]).toHaveProperty("name");
    expect(deviceTable?.columns[0]).toHaveProperty("pk");
    expect(JSON.stringify(sources)).not.toContain("sample"); // 没有采样行
    // 按连接过滤
    const one = await call("list_tables", { connection: "device_sys" });
    expect(one.result.structuredContent.sources.map((s: { connection: string }) => s.connection)).toEqual(["device_sys"]);
    // 未知连接名：槽内 error，不是信封错误
    const ghost = await call("list_tables", { connection: "ghost_db" });
    expect(ghost.error).toBeUndefined();
    expect(ghost.result.structuredContent.sources).toEqual([{ connection: "ghost_db", tables: [], error: "没有这个连接" }]);
  });
});
