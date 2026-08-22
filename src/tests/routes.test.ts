// 路由层测试：错误分层（400/422/500）与裁决走真路由的集成。
// 每用例一个临时目录 + 全新运行态（helpers.ts），与仓库运行态隔离。
// 演示模板与 fixture 连接只在 test 空间，凡依赖 equipment/repair/person 等测试数据的请求都走 ?ws=test。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { cleanupRuntime, setupRuntime } from "./helpers";
import { Verdict } from "../server/engine/verdict";

let tmp: string;

beforeEach(async () => {
  tmp = await setupRuntime("ontos-route-");
});
afterEach(async () => {
  await cleanupRuntime(tmp);
});

async function post(path: string, body?: string, headers?: Record<string, string>, ws?: string) {
  const mod = await import(`../app/api/${path}/route`);
  const res = await mod.POST(
    new Request(`http://x/api/${path}${ws ? `?ws=${ws}` : ""}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: body ?? "{}" }) as never
  );
  return { status: res.status, data: await res.json() };
}

async function get(path: string, headers?: Record<string, string>, ws?: string) {
  const mod = await import(`../app/api/${path}/route`);
  const res = await mod.GET(new Request(`http://x/api/${path}${ws ? `?ws=${ws}` : ""}`, { headers }) as never);
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
      // 只读查询不设闸（测试数据在 test 空间）
      expect((await post("query", JSON.stringify({ object: "equipment", filter: { status: "scrapped" } }), undefined, TEST)).status).toBe(200);
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
    const { getDriverRegistry } = await import("../server/engine/load");
    (await getDriverRegistry(TEST)).register("purchase_sys", {
      select: async () => { throw new Error("库炸了"); },
      insert: async () => {},
      update: async () => 0,
      delete: async () => 0,
    });
    const r = await post("query", JSON.stringify({ object: "equipment", filter: { name: { contains: "机床" } } }), undefined, TEST);
    expect(r.status).toBe(500);
    expect(r.data.error).toBe("内部错误");
  });

  it("decisions：自配对 400；同源对 422", async () => {
    expect((await post("decisions", JSON.stringify({ class_a: "equipment", class_b: "equipment", verdict: Verdict.Same }), undefined, TEST)).status).toBe(400);
    // repair 与 assignment 都来自 device_sys：同源，不是跨源候选对
    expect((await post("decisions", JSON.stringify({ class_a: "repair", class_b: "assignment", verdict: Verdict.Same }), undefined, TEST)).status).toBe(422);
  });

  it("overlap：自配对 400", async () => {
    expect((await post("overlap", JSON.stringify({ class_a: "equipment", class_b: "equipment" }), undefined, TEST)).status).toBe(400);
  });

  it("overlap：无源类 422（幻影 rate 不产）；同源对 422（不全列扫）", async () => {
    const s = await import("../server/engine/configStore");
    await s.applyOp({ op: "create_object", name: "vendor", kind: "thing" }, TEST); // 手工对象，无源
    expect((await post("overlap", JSON.stringify({ class_a: "equipment", class_b: "vendor" }), undefined, TEST)).status).toBe(422);
    // repair 与 assignment 都来自 device_sys：同源不算疑似重复
    expect((await post("overlap", JSON.stringify({ class_a: "repair", class_b: "assignment" }), undefined, TEST)).status).toBe(422);
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

describe("GET /api/ontology：rev + ETag 监视器口径", () => {
  it("200 带 rev/ETag/no-store；If-None-Match 命中回 304（也带 no-store）；内容变后旧 ETag 失效", async () => {
    const s = await import("../server/engine/configStore");
    const r1 = await get("ontology", undefined, TEST);
    expect(r1.status).toBe(200);
    expect(r1.data.rev).toBe(s.getRev(TEST));
    const etag = r1.headers.get("etag");
    expect(etag).toBe(`"test-${s.getRev(TEST)}"`);
    expect(r1.headers.get("cache-control")).toBe("no-store");
    // 命中：304 空体，同样带 no-store 与同一 ETag
    const r2 = await get("ontology", { "if-none-match": etag! }, TEST);
    expect(r2.status).toBe(304);
    expect(r2.headers.get("cache-control")).toBe("no-store");
    expect(r2.headers.get("etag")).toBe(etag);
    // 写一步之后 rev +1，旧 ETag 不再命中
    await s.applyOp({ op: "create_object", name: "vendor", kind: "thing" }, TEST);
    const r3 = await get("ontology", { "if-none-match": etag! }, TEST);
    expect(r3.status).toBe(200);
    expect(r3.data.rev).toBe(s.getRev(TEST));
    expect(r3.data.object_types.vendor).toBeDefined();
  });

  it("action_changes：未动过动作时三数组全空；新增/同名改内容/删除各就各位", async () => {
    const s = await import("../server/engine/configStore");
    const r1 = await get("ontology", undefined, TEST);
    expect(r1.data.action_changes).toEqual({ added: [], overwritten: [], removed: [] }); // 种子有 convert 等动作，但没改就不算
    const def = { effect: [{ update: { object: "equipment", identity: { from: "identity" }, properties: { name: { from: "request" } } } }] };
    await s.applyOp({ op: "set_action", object: "equipment", name: "rename", def }, TEST);
    const convertDef = structuredClone((await s.getDraft(TEST)).draft.object_types.equipment.actions!.convert);
    convertDef.description = "改过的验收入库";
    await s.applyOp({ op: "set_action", object: "equipment", name: "convert", def: convertDef }, TEST);
    await s.applyOp({ op: "remove_action", object: "equipment", name: "scrap" }, TEST);
    const r2 = await get("ontology", undefined, TEST);
    expect(r2.data.action_changes.added).toEqual(["equipment.rename"]);
    expect(r2.data.action_changes.overwritten).toEqual(["equipment.convert"]);
    expect(r2.data.action_changes.removed).toEqual(["equipment.scrap"]);
    // 同名同内容写回不算 overwritten
    const seed = structuredClone((await s.getPublished(TEST)).config.object_types.equipment.actions!.transfer);
    await s.applyOp({ op: "set_action", object: "equipment", name: "transfer", def: seed }, TEST);
    const r3 = await get("ontology", undefined, TEST);
    expect(r3.data.action_changes.overwritten).not.toContain("equipment.transfer");
  });
});

describe("裁决走真路由：草稿变更 + 留痕一体", () => {
  it("「同一」合并两个跨源类，留痕带证据；草稿可直接发布", async () => {
    const s = await import("../server/engine/configStore");
    // 造一对跨源候选：采购视角的 po_a × 设备视角的 po_b（不同名识别字段）
    await s.applyOp({ op: "import_objects", objects: {
      po_a: { kind: "thing", identity: "sn", properties: { sn: { type: "string" } }, sources: { sa: { connection: "purchase_sys", table: "po_item", pk: "po_id", fields: { sn: "sn" } } } },
      po_b: { kind: "thing", identity: "serial_no", properties: { serial_no: { type: "string" } }, sources: { sb: { connection: "device_sys", table: "device", pk: "dev_id", fields: { serial_no: "serial_no" } } } },
    } }, TEST);
    const r = await post("decisions", JSON.stringify({
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
    await s.publishDraft(TEST);
    expect((await meta.listDecisions(TEST))[0].version).toBe(2);
  });

  it("裁决被校验闸回退时不留幻影记录", async () => {
    const s = await import("../server/engine/configStore");
    await s.applyOp({ op: "import_objects", objects: {
      po_a: { kind: "thing", identity: "sn", properties: { sn: { type: "string" }, status: { type: "string" } }, sources: { sa: { connection: "purchase_sys", table: "po_item", pk: "po_id", fields: { sn: "sn", status: "sn" } } } },
      po_b: { kind: "thing", identity: "sn", properties: { sn: { type: "string" } }, sources: { sb: { connection: "device_sys", table: "device", pk: "dev_id", fields: { sn: "serial_no" } } } },
    } }, TEST);
    // po_a 已有 status 属性，「阶段」裁决撞名 → 422，且不留痕
    const r = await post("decisions", JSON.stringify({ class_a: "po_a", class_b: "po_b", verdict: Verdict.Stage, stage_names: { from: "在途", to: "在役" } }), undefined, TEST);
    expect(r.status).toBe(422);
    const meta = (await import("../server/meta/store")).metaStore();
    expect((await meta.listDecisions(TEST)).length).toBe(0);
    expect((await s.getDraft(TEST)).draft.object_types.po_b).toBeDefined(); // 草稿回退，类还在
  });

  it("「跳过」不动草稿但留痕", async () => {
    const s = await import("../server/engine/configStore");
    const before = JSON.stringify((await s.getDraft(TEST)).draft);
    const r = await post("decisions", JSON.stringify({ class_a: "equipment", class_b: "person", verdict: Verdict.Skip }), undefined, TEST);
    expect(r.status).toBe(200);
    expect(JSON.stringify((await s.getDraft(TEST)).draft)).toBe(before);
    expect((await s.getDraft(TEST)).dirty).toBe(false);
    const meta = (await import("../server/meta/store")).metaStore();
    expect((await meta.listDecisions(TEST))[0].verdict).toBe(Verdict.Skip);
  });
});
