// 路由层测试：错误分层（400/422/500）与裁决走真路由的集成。
// 每用例一个临时目录 + 全新运行态（helpers.ts），与仓库运行态隔离。
// 演示模板与 fixture 连接只在 test 空间，凡依赖 equipment/repair/person 等测试数据的请求都走 /api/test/…。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { cleanupRuntime, draftEngine, setupRuntime } from "./helpers";
import { Verdict } from "../server/schema/verdict";

let tmp: string;

beforeEach(async () => {
  tmp = await setupRuntime("ontos-route-");
});
afterEach(async () => {
  await cleanupRuntime(tmp);
});

/** 路由参数：工作空间来自路径段（/api/<空间名>/…），测试按 URL 里的段给。 */
const paramsOf = (workspace?: string) => ({ params: Promise.resolve({ workspace: workspace ?? "default" }) });

async function post(path: string, body?: string, headers?: Record<string, string>, workspace?: string) {
  const mod = await import(`../app/api/[workspace]/${path}/route`);
  const res = await mod.POST(
    new Request(`http://x/api/${workspace ?? "default"}/${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: body ?? "{}" }) as never,
    paramsOf(workspace)
  );
  return { status: res.status, data: await res.json() };
}

async function get(path: string, headers?: Record<string, string>, workspace?: string) {
  const mod = await import(`../app/api/[workspace]/${path}/route`);
  const res = await mod.GET(new Request(`http://x/api/${workspace ?? "default"}/${path}`, { headers }) as never, paramsOf(workspace));
  return { status: res.status, headers: res.headers, data: res.status === 304 ? null : await res.json() };
}

const TEST = "test";

describe("写端点令牌闸（ONTOS_TOKEN）", () => {
  it("设了令牌：写端点无令牌 401、有令牌放行；只读端点不拦；不设令牌全放开", async () => {
    // 先验默认放开（演示默认）
    expect((await post("publish", "{}")).status).toBe(200);
    process.env.ONTOS_TOKEN = "t0ken";
    try {
      expect((await post("publish", "{}")).status).toBe(401); // 无令牌
      expect((await post("publish", "{}", { authorization: "Bearer wrong" })).status).toBe(401); // 错令牌
      expect((await post("publish", "{}", { authorization: "Bearer t0ken" })).status).toBe(200); // 对令牌
      // 只读查询 / 建议不设闸（测试数据在 test 空间）
      expect((await post("query", JSON.stringify({ object: "equipment", filter: { status: "scrapped" } }), undefined, TEST)).status).toBe(200);
      expect((await post("propose_objects", JSON.stringify({ tables: [{ connection: "device_sys", table: "department" }] }), undefined, TEST)).status).toBe(200);
    } finally {
      delete process.env.ONTOS_TOKEN;
    }
  });
});

describe("错误分层：400 / 422 / 500", () => {
  it("query：坏 JSON 400；未知类 422；驱动故障 500", async () => {
    expect((await post("query", "not json")).status).toBe(400);
    expect((await post("query", JSON.stringify({ object: "ghost" }))).status).toBe(422);
    // 注入一个必炸的驱动顶替 purchase_sys：引擎故障落 500，不是 422
    const { getDriverRegistry } = await import("../server/infra/connections");
    (await getDriverRegistry(TEST)).register("purchase_sys", {
      select: async () => { throw new Error("库炸了"); },
      selectAggregate: async () => { throw new Error("库炸了"); },
      insert: async () => {},
      update: async () => 0,
      delete: async () => 0,
    });
    const r = await post("query", JSON.stringify({ object: "equipment", filter: { name: { contains: "机床" } } }), undefined, TEST);
    expect(r.status).toBe(500);
    expect(r.data.error).toBe("内部错误");
  });

  it("decisions：自配对 400；同一库两张表可以定案", async () => {
    expect((await post("decide", JSON.stringify({ class_a: "equipment", class_b: "equipment", verdict: Verdict.Same }), undefined, TEST)).status).toBe(400);
    expect((await post("decide", JSON.stringify({ class_a: "repair", class_b: "assignment", verdict: Verdict.Skip }), undefined, TEST)).status).toBe(200);
  });

  it("overlap：自配对 400", async () => {
    expect((await post("compute_overlap", JSON.stringify({ class_a: "equipment", class_b: "equipment" }), undefined, TEST)).status).toBe(400);
  });

  it("propose_pair：自配对 400；看过交集率后给出倾向", async () => {
    expect((await post("propose_pair", JSON.stringify({ class_a: "equipment", class_b: "equipment", rate: 0, count_a: 1, count_b: 1, count_hit: 0 }), undefined, TEST)).status).toBe(400);
    const r = await post("propose_pair", JSON.stringify({ class_a: "equipment", class_b: "person", rate: 0, count_a: 100, count_b: 0, count_hit: 0 }), undefined, TEST);
    expect(r.status).toBe(200);
    expect(r.data.tendency).toBeTruthy();
    expect(r.data.reason).toBeTruthy();
  });

  it("overlap：无源类 422（幻影 rate 不产）；同一库两张表可以算", async () => {
    const s = await draftEngine();
    await s.editDraft({ op: "create_object", name: "vendor", kind: "thing" }, TEST); // 手工对象，无源
    expect((await post("compute_overlap", JSON.stringify({ class_a: "equipment", class_b: "vendor" }), undefined, TEST)).status).toBe(422);
    expect((await post("compute_overlap", JSON.stringify({ class_a: "repair", class_b: "assignment" }), undefined, TEST)).status).toBe(200);
  });

  it("connections：相对路径 sqlite 按运行态 cwd 解析（不读 process.cwd）", async () => {
    // 文件放在 tmp（运行态 cwd）里：若路由绕过 runtime 读进程 cwd，会解析到真实仓库而 400
    const { writeFileSync } = await import("node:fs");
    writeFileSync(join(tmp, "rel_demo.db"), "");
    const r = await post("connections", JSON.stringify({ name: "rel_db", type: "sqlite", db_name: "rel_demo.db", test: false }));
    expect(r.status).toBe(200);
    expect(r.data.saved).toBe(true);
  });
});

describe("propose_objects：只建议不落地", () => {
  it("返回 object_types；工作副本没有新类", async () => {
    const s = await draftEngine();
    expect((await s.getDraft(TEST)).draft.object_types.po_item).toBeUndefined();
    const r = await post("propose_objects", JSON.stringify({ tables: [{ connection: "purchase_sys", table: "po_item" }] }), undefined, TEST);
    expect(r.status).toBe(200);
    expect(r.data.object_types.po_item).toBeTruthy();
    expect((await s.getDraft(TEST)).draft.object_types.po_item).toBeUndefined();
  });

  it("空 tables 400；表不存在 422", async () => {
    expect((await post("propose_objects", JSON.stringify({ tables: [] }), undefined, TEST)).status).toBe(400);
    const r = await post("propose_objects", JSON.stringify({ tables: [{ connection: "device_sys", table: "ghost" }] }), undefined, TEST);
    expect(r.status).toBe(422);
    expect(r.data.error).toMatch(/表不存在/);
  });

  it("跨次生成撞名：草稿已有 customer 时改成 crm_sys_customer 再交还，落地不 422；不占用仍用表名", async () => {
    const s = await draftEngine();
    // 挂一个带 customer 表的连接（走查第三波的情形：上一波已生成销售客户 customer）；用完注销，不留进共享注册表
    const { getDriverRegistry } = await import("../server/infra/connections");
    const { SqliteDriver } = await import("../server/infra/sqliteDriver");
    const registry = await getDriverRegistry(TEST);
    const d = new SqliteDriver();
    d.register("crm_sys").exec(`CREATE TABLE customer (cust_no TEXT PRIMARY KEY, name TEXT)`);
    registry.register("crm_sys", d);
    try {
    await s.editDraft(
      { op: "import_objects", objects: { customer: { kind: "thing", identity: "cust_no", properties: { cust_no: { type: "string" } } } } },
      TEST
    );
    const r = await post("propose_objects", JSON.stringify({ tables: [{ connection: "crm_sys", table: "customer" }] }), undefined, TEST);
    expect(r.status).toBe(200);
    expect(r.data.object_types.customer).toBeUndefined();
    expect(r.data.object_types.crm_sys_customer).toBeTruthy(); // 硬闸改名后的键
    const imp = await post("edit_draft", JSON.stringify({ op: "import_objects", objects: r.data.object_types }), undefined, TEST);
    expect(imp.status).toBe(200); // 落地不撞「类已存在」
    expect((await s.getDraft(TEST)).draft.object_types.crm_sys_customer).toBeDefined();
    // 不占用的表仍用表名，不乱加前缀
    const r2 = await post("propose_objects", JSON.stringify({ tables: [{ connection: "purchase_sys", table: "po_item" }] }), undefined, TEST);
    expect(r2.data.object_types.po_item).toBeTruthy();
    expect(r2.data.object_types.purchase_sys_po_item).toBeUndefined();
    // import_objects 本身不静默改名：直接撞已有类名仍整批 422（MCP 直接 apply 的路径保持这个语义）
    const direct = await post(
      "edit_draft",
      JSON.stringify({ op: "import_objects", objects: { customer: { kind: "thing", identity: "x", properties: { x: { type: "string" } } } } }),
      undefined,
      TEST
    );
    expect(direct.status).toBe(422);
    expect(direct.data.error).toMatch(/类已存在/);
    } finally {
      registry.unregister("crm_sys"); // 挂进共享注册表的临时连接，用完摘掉
    }
  });
});

describe("查询留痕", () => {
  it("log_query 落 query_json 原文（不是函数序列化出来的空）", async () => {
    const body = { object: "equipment", properties: ["name"], filter: { status: "in_transit" } };
    expect((await post("query", JSON.stringify(body), undefined, TEST)).status).toBe(200);
    const meta = (await import("../server/meta/store")).metaStore();
    const logs = await meta.listQueryLogs(TEST);
    expect(logs.length).toBe(1);
    expect(JSON.parse(logs[0].query_json as string)).toEqual(body);
  });
});

describe("GET /api/ontology：rev + ETag 监视器口径", () => {
  it("200 带 rev/ETag/no-store；If-None-Match 命中回 304（也带 no-store）；内容变后旧 ETag 失效", async () => {
    const s = await draftEngine();
    const r1 = await get("ontology", undefined, TEST);
    expect(r1.status).toBe(200);
    expect(r1.data.rev).toBe(await s.getRev(TEST));
    const etag = r1.headers.get("etag");
    expect(etag).toBe(`"test-${await s.getRev(TEST)}"`);
    expect(r1.headers.get("cache-control")).toBe("no-store");
    // 命中：304 空体，同样带 no-store 与同一 ETag
    const r2 = await get("ontology", { "if-none-match": etag! }, TEST);
    expect(r2.status).toBe(304);
    expect(r2.headers.get("cache-control")).toBe("no-store");
    expect(r2.headers.get("etag")).toBe(etag);
    // 写一步之后 rev +1，旧 ETag 不再命中
    await s.editDraft({ op: "create_object", name: "vendor", kind: "thing" }, TEST);
    const r3 = await get("ontology", { "if-none-match": etag! }, TEST);
    expect(r3.status).toBe(200);
    expect(r3.data.rev).toBe(await s.getRev(TEST));
    expect(r3.data.object_types.vendor).toBeDefined();
  });

  it("action_changes：未动过动作时三数组全空；新增/同名改内容/删除各就各位", async () => {
    const s = await draftEngine();
    const r1 = await get("ontology", undefined, TEST);
    expect(r1.data.action_changes).toEqual({ added: [], overwritten: [], removed: [] }); // 种子有 convert 等动作，但没改就不算
    const def = { effect: [{ update: { object: "equipment", identity: { from: "identity" }, properties: { name: { from: "request" } } } }] };
    await s.editDraft({ op: "set_action", object: "equipment", name: "rename", def }, TEST);
    const convertDef = structuredClone((await s.getDraft(TEST)).draft.object_types.equipment.actions!.convert);
    convertDef.description = "改过的验收入库";
    await s.editDraft({ op: "set_action", object: "equipment", name: "convert", def: convertDef }, TEST);
    await s.editDraft({ op: "remove_action", object: "equipment", name: "scrap" }, TEST);
    const r2 = await get("ontology", undefined, TEST);
    expect(r2.data.action_changes.added).toEqual(["equipment.rename"]);
    expect(r2.data.action_changes.overwritten).toEqual(["equipment.convert"]);
    expect(r2.data.action_changes.removed).toEqual(["equipment.scrap"]);
    // 同名同内容写回不算 overwritten
    const seed = structuredClone((await s.getPublished(TEST)).config.object_types.equipment.actions!.transfer);
    await s.editDraft({ op: "set_action", object: "equipment", name: "transfer", def: seed }, TEST);
    const r3 = await get("ontology", undefined, TEST);
    expect(r3.data.action_changes.overwritten).not.toContain("equipment.transfer");
  });
});

describe("裁决走真路由：草稿变更 + 留痕一体", () => {
  it("「同一」合并两个跨源类，留痕带证据；草稿可直接发布", async () => {
    const s = await draftEngine();
    // 造一对跨源候选：采购视角的 po_a × 设备视角的 po_b（不同名识别字段）
    await s.editDraft({ op: "import_objects", objects: {
      po_a: { kind: "thing", identity: "sn", properties: { sn: { type: "string" } }, sources: { sa: { connection: "purchase_sys", table: "po_item", pk: "po_id", fields: { sn: "sn" } } } },
      po_b: { kind: "thing", identity: "serial_no", properties: { serial_no: { type: "string" } }, sources: { sb: { connection: "device_sys", table: "device", pk: "dev_id", fields: { serial_no: "serial_no" } } } },
    } }, TEST);
    const r = await post("decide", JSON.stringify({
      class_a: "po_a", class_b: "po_b", verdict: Verdict.Same,
      evidence: { norm_rule: "serial", count_a: 121, count_b: 100, count_hit: 40, rate: 0.33 },
    }), undefined, TEST);
    expect(r.status).toBe(200);
    const d = (await s.getDraft(TEST)).draft;
    expect(d.object_types.po_b).toBeUndefined();
    expect(d.object_types.po_a.sources!.sb.fields.sn).toBe("serial_no"); // 识别字段键改写
    // 留痕落库：结论 + 证据快照 + 未绑版本（发布时回填）
    const meta = (await import("../server/meta/store")).metaStore();
    const dec = (await meta.listDecisions(TEST))[0];
    expect(dec.verdict).toBe(Verdict.Same);
    expect(dec.evidence?.count_hit).toBe(40);
    expect(dec.version).toBeNull();
    // 发布后回填版本
    await s.publish(TEST);
    expect((await meta.listDecisions(TEST))[0].version).toBe(2);
  });

  it("裁决被校验闸回退时不留幻影记录", async () => {
    const s = await draftEngine();
    await s.editDraft({ op: "import_objects", objects: {
      po_a: { kind: "thing", identity: "sn", properties: { sn: { type: "string" }, status: { type: "string" } }, sources: { sa: { connection: "purchase_sys", table: "po_item", pk: "po_id", fields: { sn: "sn", status: "sn" } } } },
      po_b: { kind: "thing", identity: "sn", properties: { sn: { type: "string" } }, sources: { sb: { connection: "device_sys", table: "device", pk: "dev_id", fields: { sn: "serial_no" } } } },
    } }, TEST);
    // po_a 已有 status 属性，「阶段」裁决撞名 → 422，且不留痕
    const r = await post("decide", JSON.stringify({ class_a: "po_a", class_b: "po_b", verdict: Verdict.Stage, stage_names: { from: "在途", to: "在役" } }), undefined, TEST);
    expect(r.status).toBe(422);
    const meta = (await import("../server/meta/store")).metaStore();
    expect((await meta.listDecisions(TEST)).length).toBe(0);
    expect((await s.getDraft(TEST)).draft.object_types.po_b).toBeDefined(); // 草稿回退，类还在
  });

  it("「跳过」不动草稿但留痕", async () => {
    const s = await draftEngine();
    const before = JSON.stringify((await s.getDraft(TEST)).draft);
    const r = await post("decide", JSON.stringify({ class_a: "equipment", class_b: "person", verdict: Verdict.Skip }), undefined, TEST);
    expect(r.status).toBe(200);
    expect(JSON.stringify((await s.getDraft(TEST)).draft)).toBe(before);
    expect((await s.getDraft(TEST)).dirty).toBe(false);
    const meta = (await import("../server/meta/store")).metaStore();
    expect((await meta.listDecisions(TEST))[0].verdict).toBe(Verdict.Skip);
  });
});

describe("list_sqlite_files：连接表单的 sqlite 文件选择器", () => {
  it("列演示目录里的 .db 文件：建议连接名（DEMO_SYSTEMS 优先）、相对路径、已连接标记；推不出合法名的文件不列", async () => {
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const { DatabaseSync } = await import("node:sqlite");
    const demo = join(tmp, ".ontos-demo");
    mkdirSync(demo, { recursive: true });
    const mk = (file: string, sql: string) => {
      const db = new DatabaseSync(join(demo, file));
      db.exec(sql);
      db.close();
    };
    mk("purchase.db", "CREATE TABLE po_item (po_id INTEGER PRIMARY KEY, item_name TEXT)");
    mk("my_custom.db", "CREATE TABLE t (id INTEGER PRIMARY KEY)");
    writeFileSync(join(demo, "9x.db"), ""); // 推不出合法连接名（NAME_RE）：不列
    writeFileSync(join(demo, "readme.txt"), "x"); // 非 .db：不列
    const r1 = await get("list_sqlite_files");
    expect(r1.status).toBe(200);
    expect(r1.data.files).toEqual([
      { file: "my_custom.db", path: ".ontos-demo/my_custom.db", connection: "my_custom", connected: false },
      { file: "purchase.db", path: ".ontos-demo/purchase.db", title: "采购系统", connection: "purchase_sys", connected: false },
    ]);
    // 保存一个后：已连接标记翻转
    await post("connections", JSON.stringify({ name: "purchase_sys", type: "sqlite", db_name: ".ontos-demo/purchase.db", test: false }));
    const r2 = await get("list_sqlite_files");
    expect(r2.status).toBe(200);
    const purchase = r2.data.files.find((f: { file: string }) => f.file === "purchase.db");
    expect(purchase.connected).toBe(true);
  });
});
