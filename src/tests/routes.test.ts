// 路由层测试：错误分层（400/422/500）与裁决走真路由的集成。
// 每用例一个临时目录 + 全新运行态（helpers.ts），与仓库运行态隔离。

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { join } from "node:path";
import { cleanupRuntime, setupRuntime } from "./helpers";

let tmp: string;

beforeEach(async () => {
  tmp = await setupRuntime("ontos-route-");
});
afterEach(async () => {
  await cleanupRuntime(tmp);
});

async function post(path: string, body?: string, headers?: Record<string, string>) {
  const mod = await import(`../app/api/${path}/route`);
  const res = await mod.POST(
    new Request(`http://x/api/${path}`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: body ?? "{}" }) as never
  );
  return { status: res.status, data: await res.json() };
}

describe("写端点令牌闸（ONTOS_TOKEN）", () => {
  it("设了令牌：写端点无令牌 401、有令牌放行；只读端点不拦；不设令牌全放开", async () => {
    // 先验默认放开（演示默认）
    expect((await post("publish", "{}")).status).toBe(200);
    process.env.ONTOS_TOKEN = "t0ken";
    try {
      expect((await post("publish", "{}")).status).toBe(401); // 无令牌
      expect((await post("publish", "{}", { authorization: "Bearer wrong" })).status).toBe(401); // 错令牌
      expect((await post("publish", "{}", { authorization: "Bearer t0ken" })).status).toBe(200); // 对令牌
      // 只读查询不设闸
      expect((await post("query", JSON.stringify({ object: "equipment", filter: { status: "scrapped" } }))).status).toBe(200);
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
    (await getDriverRegistry()).register("purchase_sys", {
      select: async () => { throw new Error("库炸了"); },
      insert: async () => {},
      update: async () => 0,
      delete: async () => 0,
    });
    const r = await post("query", JSON.stringify({ object: "equipment", filter: { name: { contains: "机床" } } }));
    expect(r.status).toBe(500);
    expect(r.data.error).toBe("内部错误");
  });

  it("decisions：自配对 400；同源对 422", async () => {
    expect((await post("decisions", JSON.stringify({ class_a: "equipment", class_b: "equipment", verdict: "同一" }))).status).toBe(400);
    // repair 与 assignment 都来自 device_sys：同源，不是跨源候选对
    expect((await post("decisions", JSON.stringify({ class_a: "repair", class_b: "assignment", verdict: "同一" }))).status).toBe(422);
  });

  it("overlap：自配对 400", async () => {
    expect((await post("overlap", JSON.stringify({ class_a: "equipment", class_b: "equipment" }))).status).toBe(400);
  });

  it("overlap：无源类 422（幻影 rate 不产）；同源对 422（不全列扫）", async () => {
    const s = await import("../server/engine/configStore");
    await s.applyOp({ op: "create_object", name: "vendor", kind: "thing" }); // 手工对象，无源
    expect((await post("overlap", JSON.stringify({ class_a: "equipment", class_b: "vendor" }))).status).toBe(422);
    // repair 与 assignment 都来自 device_sys：同源不算疑似重复
    expect((await post("overlap", JSON.stringify({ class_a: "repair", class_b: "assignment" }))).status).toBe(422);
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

describe("裁决走真路由：草稿变更 + 留痕一体", () => {
  it("「同一」合并两个跨源类，留痕带证据；草稿可直接发布", async () => {
    const s = await import("../server/engine/configStore");
    // 造一对跨源候选：采购视角的 po_a × 设备视角的 po_b（不同名识别字段）
    await s.applyOp({ op: "import_objects", objects: {
      po_a: { kind: "thing", identity: "sn", properties: { sn: { type: "string" } }, sources: { sa: { connection: "purchase_sys", table: "po_item", pk: "po_id", fields: { sn: "sn" } } } },
      po_b: { kind: "thing", identity: "serial_no", properties: { serial_no: { type: "string" } }, sources: { sb: { connection: "device_sys", table: "device", pk: "dev_id", fields: { serial_no: "serial_no" } } } },
    } });
    const r = await post("decisions", JSON.stringify({
      class_a: "po_a", class_b: "po_b", verdict: "同一",
      evidence: { norm_rule: "serial", count_a: 121, count_b: 100, count_hit: 40, rate: 0.33 },
    }));
    expect(r.status).toBe(200);
    const d = (await s.getDraft()).draft;
    expect(d.object_types.po_b).toBeUndefined();
    expect(d.object_types.po_a.sources!.sb.fields.sn).toBe("serial_no"); // 识别字段键改写
    // 留痕落库：结论 + 证据快照 + 未绑版本（发布时回填）
    const meta = (await import("../server/meta/store")).metaStore();
    const dec = (await meta.listDecisions("default"))[0];
    expect(dec.verdict).toBe("同一");
    expect(dec.evidence?.count_hit).toBe(40);
    expect(dec.version).toBeNull();
    // 发布后回填版本
    await s.publishDraft();
    expect((await meta.listDecisions("default"))[0].version).toBe(2);
  });

  it("裁决被校验闸回退时不留幻影记录", async () => {
    const s = await import("../server/engine/configStore");
    await s.applyOp({ op: "import_objects", objects: {
      po_a: { kind: "thing", identity: "sn", properties: { sn: { type: "string" }, status: { type: "string" } }, sources: { sa: { connection: "purchase_sys", table: "po_item", pk: "po_id", fields: { sn: "sn", status: "sn" } } } },
      po_b: { kind: "thing", identity: "sn", properties: { sn: { type: "string" } }, sources: { sb: { connection: "device_sys", table: "device", pk: "dev_id", fields: { sn: "serial_no" } } } },
    } });
    // po_a 已有 status 属性，「阶段」裁决撞名 → 422，且不留痕
    const r = await post("decisions", JSON.stringify({ class_a: "po_a", class_b: "po_b", verdict: "阶段", stage_names: { from: "在途", to: "在役" } }));
    expect(r.status).toBe(422);
    const meta = (await import("../server/meta/store")).metaStore();
    expect((await meta.listDecisions("default")).length).toBe(0);
    expect((await s.getDraft()).draft.object_types.po_b).toBeDefined(); // 草稿回退，类还在
  });

  it("「跳过」不动草稿但留痕", async () => {
    const s = await import("../server/engine/configStore");
    const before = JSON.stringify((await s.getDraft()).draft);
    const r = await post("decisions", JSON.stringify({ class_a: "equipment", class_b: "person", verdict: "跳过" }));
    expect(r.status).toBe(200);
    expect(JSON.stringify((await s.getDraft()).draft)).toBe(before);
    expect((await s.getDraft()).dirty).toBe(false);
    const meta = (await import("../server/meta/store")).metaStore();
    expect((await meta.listDecisions("default"))[0].verdict).toBe("跳过");
  });
});
