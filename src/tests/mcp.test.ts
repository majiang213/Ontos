// MCP 工具端点测试：JSON-RPC 信封、十四个工具的形状与纪律（从 m4m6.test.ts 拆出）。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { cleanupRuntime, draftEngine, setupRuntime } from "./helpers";

describe("MCP 工具端点", () => {
  // 路由读运行态 cwd 下的已发布配置与元数据库——每用例一个临时目录 + 全新运行态，与仓库运行态隔离
  let tmp: string;
  beforeEach(async () => {
    tmp = await setupRuntime("ontos-mcp-"); // fixture 内存库会被 run_action 真改，用例间要全新
  });
  afterEach(async () => {
    await cleanupRuntime(tmp);
  });

  /** JSON-RPC 2.0 调用：HTTP 一律 200，成败看信封（result / error）。测试数据在 test 空间（路径段）。 */
  async function rpc(method: string, params?: Record<string, unknown>, rawBody?: string, headers?: Record<string, string>) {
    const { POST } = await import("../app/api/[workspace]/mcp/route");
    const req = new Request("http://localhost/api/test/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: rawBody ?? JSON.stringify({ jsonrpc: "2.0", id: 7, method, params }),
    });
    const res = await POST(req as never, { params: Promise.resolve({ workspace: "test" }) });
    return (await res.json()) as { id?: unknown; result?: any; error?: { code: number; message: string } };
  }
  const call = (name: string, args: Record<string, unknown>, headers?: Record<string, string>) => rpc("tools/call", { name, arguments: args }, undefined, headers);

  it("initialize 握手 + tools/list 列出十四个工具（顺序钉死）+ id 回显", async () => {
    const init = await rpc("initialize");
    expect(init.id).toBe(7);
    expect(init.result.serverInfo.name).toBe("ontos");
    const list = await rpc("tools/list");
    expect(list.result.tools.map((t: { name: string }) => t.name)).toEqual([
      "query",
      "run_action",
      "propose_objects",
      "propose_action",
      "list_classes",
      "read_class",
      "search",
      "list_candidates",
      "propose_key",
      "compute_overlap",
      "propose_pair",
      "decide",
      "list_tables",
      "edit_draft",
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

  it("propose_objects：对表产草稿建议（不落画布）", async () => {
    const r = await call("propose_objects", { tables: [{ connection: "device_sys", table: "department" }] });
    expect(r.result.structuredContent.object_types.department.properties.dept_name).toBeDefined();
  });

  it("propose_action：有转化关系的类给转化模板", async () => {
    const r = await call("propose_action", { object: "equipment" });
    expect(r.result.structuredContent.name).toBe("convert_to_in_service");
    expect(r.result.structuredContent.action.effect).toEqual([{ link: "converted" }]);
  });

  it("propose_action：非转化类给 set_fields 骨架（与导入自动生成同形同名）", async () => {
    const r = await call("propose_action", { object: "department" });
    const sc = r.result.structuredContent;
    expect(sc.name).toBe("set_fields");
    expect(sc.action.effect).toEqual([{ update: { object: "department", identity: { from: "identity" }, properties: { name: { from: "request" } } } }]); // dept_id 是唯一键，不进
  });

  it("未知工具 -32601；入参形状不合法 -32602；领域拒绝 -32000；坏 JSON -32700", async () => {
    expect((await call("fly", {})).error?.code).toBe(-32601);
    expect((await call("query", { query: { limit: "lots" } })).error?.code).toBe(-32602);
    expect((await call("query", { query: { object: "ghost" } })).error?.code).toBe(-32000);
    expect((await rpc("tools/list", undefined, "not json")).error?.code).toBe(-32700);
  });

  it("发现工具说明点明已发布/草稿；space 非法值 -32602；query/run_action/propose_objects 不接受 space", async () => {
    const list = await rpc("tools/list");
    const descOf = (n: string) => list.result.tools.find((t: { name: string }) => t.name === n).description as string;
    for (const n of ["list_classes", "read_class", "search", "propose_action"]) {
      expect(descOf(n)).toMatch(/已发布|草稿/); // 钉死：说明必须点明两个世界，防回归成「全部的类」
    }
    expect((await call("list_classes", { space: "Draft" })).error?.code).toBe(-32602);
    expect((await call("search", { text: "设备", space: "working" })).error?.code).toBe(-32602);
    expect((await call("query", { query: { object: "equipment" }, space: "draft" })).error?.code).toBe(-32602);
    expect((await call("run_action", { action: "convert", object: "equipment", identity: "SN-40217", space: "draft" })).error?.code).toBe(-32602);
    expect((await call("propose_objects", { tables: [{ connection: "device_sys", table: "department" }], space: "draft" })).error?.code).toBe(-32602);
    expect((await call("list_candidates", { space: "draft" })).error?.code).toBe(-32602);
    expect((await call("decide", { class_a: "repair", class_b: "assignment", verdict: "skip", space: "draft" })).error?.code).toBe(-32602);
    expect((await call("propose_key", { object: "po_item", space: "draft" })).error?.code).toBe(-32602);
  });

  it("space=draft 看见未发布类（带状态与 rev）；缺省看不见；query/propose_action 不受草稿影响", async () => {
    const s = await draftEngine();
    await s.editDraft({ op: "create_object", name: "vendor", description: "供应商", kind: "thing" }, "test");
    // 缺省已发布：看不见 vendor
    const pub = await call("list_classes", {});
    expect(pub.result.structuredContent.classes.map((c: { name: string }) => c.name)).not.toContain("vendor");
    // 草稿：看得见，带 state / dirty / rev / base_version
    const d = await call("list_classes", { space: "draft" });
    const sc = d.result.structuredContent;
    expect(sc.space).toBe("draft");
    expect(sc.dirty).toBe(true);
    expect(sc.rev).toBe(await s.getRev("test"));
    expect(sc.base_version).toBe(1);
    expect(sc.classes.find((c: { name: string }) => c.name === "vendor").state).toBe("new");
    expect(sc.classes.find((c: { name: string }) => c.name === "vendor").identity).toBeUndefined();
    expect(sc.classes.find((c: { name: string }) => c.name === "equipment").state).toBe("same");
    expect(sc.classes.find((c: { name: string }) => c.name === "equipment").identity).toBe("serial_no");
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

  it("edit_draft 的 inputSchema：存在、不含 save_layout、base_rev 必填；list_tables/edit_draft 不接受 space", async () => {
    const list = await rpc("tools/list");
    const ad = list.result.tools.find((t: { name: string }) => t.name === "edit_draft");
    expect(ad.inputSchema).toBeDefined();
    expect(JSON.stringify(ad.inputSchema)).not.toContain("save_layout");
    expect(ad.inputSchema.required).toContain("base_rev");
    expect((await call("edit_draft", { op: "create_object", name: "vendor", kind: "thing", base_rev: 0, space: "draft" })).error?.code).toBe(-32602);
    expect((await call("list_tables", { space: "draft" })).error?.code).toBe(-32602);
    expect((await call("list_candidates", { space: "draft" })).error?.code).toBe(-32602);
  });

  it("edit_draft：信封校验（缺 base_rev / 字符串 base_rev）-32602；save_layout -32602", async () => {
    expect((await call("edit_draft", { op: "create_object", name: "vendor", kind: "thing" })).error?.code).toBe(-32602); // 缺 base_rev
    expect((await call("edit_draft", { op: "create_object", name: "vendor", kind: "thing", base_rev: "12" })).error?.code).toBe(-32602); // 字符串不行
    expect((await call("edit_draft", { op: "save_layout", positions: {}, base_rev: 0 })).error?.code).toBe(-32602); // 摆位不在 MCP 联合里
    expect((await call("edit_draft", { op: "fly", base_rev: 0 })).error?.code).toBe(-32602); // 未知 op
  });

  it("edit_draft：ONTOS_TOKEN 设了之后无令牌 -32001，有令牌放行", async () => {
    process.env.ONTOS_TOKEN = "t0ken";
    try {
      expect((await call("edit_draft", { op: "create_object", name: "vendor", kind: "thing", base_rev: 0 })).error?.code).toBe(-32001);
      const ok = await call("edit_draft", { op: "create_object", name: "vendor", kind: "thing", base_rev: 0 }, { authorization: "Bearer t0ken" });
      expect(ok.error).toBeUndefined();
      expect(ok.result.structuredContent.ok).toBe(true);
    } finally {
      delete process.env.ONTOS_TOKEN;
    }
  });

  it("edit_draft 完整往返：读 rev → 写入 ok 且 rev+1 → 重放 stale base_rev 得 -32000 → query 仍读旧已发布", async () => {
    const s = await draftEngine();
    const list = await call("list_classes", { space: "draft" });
    const rev = list.result.structuredContent.rev as number;
    expect(rev).toBe(await s.getRev("test"));
    // 落地 import_objects（propose_objects 的落地点）
    const imp = await call("edit_draft", {
      op: "import_objects",
      objects: { vendor: { kind: "thing", description: "供应商", identity: "vendor_no", properties: { vendor_no: { type: "string" } } } },
      base_rev: rev,
    });
    expect(imp.error).toBeUndefined();
    expect(imp.result.structuredContent).toMatchObject({ ok: true, dirty: true, rev: rev + 1, base_version: 1, op: "import_objects", names: ["vendor"] });
    // 逐步 op：base_rev 跟上后成功，rev 再 +1，names 收类名
    const add = await call("edit_draft", { op: "add_property", object: "vendor", name: "vendor_name", type: "string", base_rev: rev + 1 });
    expect(add.result.structuredContent).toMatchObject({ ok: true, rev: rev + 2, names: ["vendor"] });
    // 重放同一个 stale base_rev → DraftReject → -32000，且不落地
    const replay = await call("edit_draft", { op: "add_property", object: "vendor", name: "ghost_prop", type: "string", base_rev: rev + 1 });
    expect(replay.error?.code).toBe(-32000);
    expect(replay.error?.message).toMatch(/草稿已变/);
    expect((await s.getDraft("test")).draft.object_types.vendor.properties.ghost_prop).toBeUndefined();
    // query 仍只读已发布：未发布的 vendor 查不到
    expect((await call("query", { query: { object: "vendor" } })).error?.code).toBe(-32000);
    // 撞名 → -32000；锁定的整份替换（已发布类）→ -32000 带白话原因
    expect((await call("edit_draft", { op: "import_objects", objects: { vendor: { kind: "thing", properties: {} } }, base_rev: await s.getRev("test") })).error?.code).toBe(-32000);
    const lock = await call("edit_draft", { op: "replace_object", name: "equipment", def: { kind: "thing", properties: {} }, base_rev: await s.getRev("test") });
    expect(lock.error?.code).toBe(-32000);
    expect(lock.error?.message).toMatch(/不能整对象替换：已经发布过/);
    // 已发布类的草稿视图：replaceable=false 且带原因
    const rc = await call("read_class", { name: "equipment", space: "draft" });
    expect(rc.result.structuredContent.replaceable).toBe(false);
    expect(rc.result.structuredContent.replace_blockers.length).toBeGreaterThan(0);
    // 未锁定的草稿新类：replaceable=true
    const rv = await call("read_class", { name: "vendor", space: "draft" });
    expect(rv.result.structuredContent.replaceable).toBe(true);
    // list_classes 草稿视图带 outlets（ADR 0012 世界无外发出口：空表）
    expect((await call("list_classes", { space: "draft" })).result.structuredContent.outlets).toEqual([]);
  });

  it("list_tables：列定义无采样行；按连接过滤；未知连接名收在槽内 error", async () => {
    const all = await call("list_tables", {});
    const sources = all.result.structuredContent.sources as { connection: string; tables: { name: string; columns: Record<string, unknown>[] }[] }[];
    expect(sources.length).toBe(7); // test 空间七个 fixture 连接（ADR 0012）
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

  it("list_candidates：只看草稿里的疑似重复，不定案", async () => {
    const s = await draftEngine();
    const rev = (await call("list_classes", { space: "draft" })).result.structuredContent.rev as number;
    const imp = await call("edit_draft", {
      op: "import_objects",
      objects: {
        po_a: { kind: "thing", identity: "sn", properties: { sn: { type: "string" }, name: { type: "string" } }, sources: { sa: { connection: "purchase_sys", table: "po_item", pk: "po_id", fields: { sn: "sn", name: "item_name" } } } },
        po_b: { kind: "thing", identity: "sn", properties: { sn: { type: "string" }, name: { type: "string" } }, sources: { sb: { connection: "device_sys", table: "device", pk: "dev_id", fields: { sn: "serial_no", name: "name" } } } },
      },
      base_rev: rev,
    });
    expect(imp.error).toBeUndefined();
    const r = await call("list_candidates", {});
    expect(r.error).toBeUndefined();
    const pairs = r.result.structuredContent.candidates as { class_a: string; class_b: string; tendency: string; reason: string }[];
    const hit = pairs.filter((p) => (p.class_a === "po_a" && p.class_b === "po_b") || (p.class_a === "po_b" && p.class_b === "po_a"));
    expect(hit).toHaveLength(1);
    expect(hit[0].tendency).toBeTruthy();
    expect(hit[0].reason).toBeTruthy();
    expect((await s.getDraft("test")).draft.object_types.po_a).toBeDefined();
    expect((await s.getDraft("test")).draft.object_types.po_b).toBeDefined(); // 只看，没把两并成一个
  });

  it("Agent 整合全链路：propose_key → compute_overlap → propose_pair → decide(same) 合并 + 留痕；propose_* 一律不落地", async () => {
    const s = await draftEngine();
    const rev = (await call("list_classes", { space: "draft" })).result.structuredContent.rev as number;
    const imp = await call("edit_draft", {
      op: "import_objects",
      objects: {
        po_a: { kind: "thing", identity: "sn", description: "采购单行", properties: { sn: { type: "string" }, name: { type: "string" } }, sources: { sa: { connection: "purchase_sys", table: "po_item", pk: "po_id", fields: { sn: "sn", name: "item_name" } } } },
        po_b: { kind: "thing", identity: "sn", description: "设备台账", properties: { sn: { type: "string" }, name: { type: "string" } }, sources: { sb: { connection: "device_sys", table: "device", pk: "dev_id", fields: { sn: "serial_no", name: "name" } } } },
      },
      base_rev: rev,
    });
    expect(imp.error).toBeUndefined();
    // 出键建议：只建议，草稿 identity 不动
    const key = await call("propose_key", { object: "po_a" });
    expect(key.error).toBeUndefined();
    expect(key.result.structuredContent.key).toBe("sn");
    expect((await s.getDraft("test")).draft.object_types.po_a.identity).toBe("sn");
    // 算交集 → 二轮倾向 → 落结论（证据随行进留痕）
    const ov = await call("compute_overlap", { class_a: "po_a", class_b: "po_b" });
    expect(ov.error).toBeUndefined();
    const { rate, count_a, count_b, count_hit } = ov.result.structuredContent as { rate: number; count_a: number; count_b: number; count_hit: number };
    const pair = await call("propose_pair", { class_a: "po_a", class_b: "po_b", rate, count_a, count_b, count_hit });
    expect(pair.error).toBeUndefined();
    expect(pair.result.structuredContent.tendency).toBeTruthy();
    expect(pair.result.structuredContent.reason).toBeTruthy();
    // 未授权写闸：decide 是写工具，没令牌 -32001
    process.env.ONTOS_TOKEN = "t0ken";
    try {
      expect((await call("compute_overlap", { class_a: "po_a", class_b: "po_b" })).error?.code).toBe(-32001); // 全量扫 + 落计数，写闸与 REST 对齐
      expect((await call("decide", { class_a: "po_a", class_b: "po_b", verdict: "same" })).error?.code).toBe(-32001);
      const dec = await call("decide", { class_a: "po_a", class_b: "po_b", verdict: "same", evidence: { rate, count_a, count_b, count_hit } }, { authorization: "Bearer t0ken" });
      expect(dec.error).toBeUndefined();
      expect(dec.result.structuredContent).toMatchObject({ ok: true, recorded: true });
    } finally {
      delete process.env.ONTOS_TOKEN;
    }
    // 合并落地：po_b 消亡，po_a 挂两个源；留痕带 Agent 判定者与证据
    const draft = (await s.getDraft("test")).draft;
    expect(draft.object_types.po_b).toBeUndefined();
    expect(Object.keys(draft.object_types.po_a.sources ?? {})).toEqual(["sa", "sb"]);
    const { metaStore } = await import("../server/meta/store");
    const decisions = await metaStore().listDecisions("test");
    expect(decisions.at(-1)).toMatchObject({ class_a: "po_a", class_b: "po_b", verdict: "same", decided_by: "Agent（MCP）" });
    expect(decisions.at(-1)?.evidence).toMatchObject({ rate, count_a, count_b, count_hit });
  });

  it("decide：自配对 -32602；缺工具无 —— publish 永不在工具清单", async () => {
    expect((await call("decide", { class_a: "equipment", class_b: "equipment", verdict: "same" })).error?.code).toBe(-32602);
    expect((await call("compute_overlap", { class_a: "equipment", class_b: "equipment" })).error?.code).toBe(-32602);
    const list = await rpc("tools/list");
    expect(list.result.tools.map((t: { name: string }) => t.name)).not.toContain("publish");
  });

  it("set_action 经 edit_draft 落地：草稿视图读回完整定义；names 是 类名.动作名；发布前已发布世界不受影响", async () => {
    const s = await draftEngine();
    const def = { description: "改名", effect: [{ update: { object: "equipment", identity: { from: "identity" }, properties: { name: { from: "request" } } } }] };
    const r = await call("edit_draft", { op: "set_action", object: "equipment", name: "rename", def, base_rev: await s.getRev("test") });
    expect(r.error).toBeUndefined();
    expect(r.result.structuredContent.names).toEqual(["equipment.rename"]);
    // 草稿视图：完整动作定义（读回-改-写回闭环）
    const rc = await call("read_class", { name: "equipment", space: "draft" });
    const act = rc.result.structuredContent.actions.find((a: { name: string }) => a.name === "rename");
    expect(act.def).toEqual(def);
    // 已发布视图：看不见这条动作，且任何动作都不带 def（问数 Agent 不碰写侧）
    const pub = await call("read_class", { name: "equipment" });
    expect(pub.result.structuredContent.actions.find((a: { name: string }) => a.name === "rename")).toBeUndefined();
    expect(pub.result.structuredContent.actions.every((a: { def?: unknown }) => a.def === undefined)).toBe(true);
    // run_action 只执行已发布快照：草稿里的动作执行不了（业务失败 isError，不是信封错误）
    const run = await call("run_action", { action: "rename", object: "equipment", identity: "SN-40217" });
    expect(run.error).toBeUndefined();
    expect(run.result.isError).toBe(true);
    // remove_action：names 同样是 类名.动作名
    const rm = await call("edit_draft", { op: "remove_action", object: "equipment", name: "rename", base_rev: await s.getRev("test") });
    expect(rm.error).toBeUndefined();
    expect(rm.result.structuredContent.names).toEqual(["equipment.rename"]);
    expect((await s.getDraft("test")).draft.object_types.equipment.actions!.rename).toBeUndefined();
  });
});
