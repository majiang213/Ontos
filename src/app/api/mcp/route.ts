// MCP 端点：JSON-RPC 2.0 信封（Streamable HTTP 形态），外部 Agent 经这里调 Ontos 的工具。
// initialize 握手；tools/list 列工具；tools/call 执行。循环不做进 Ontos——外部 Agent 是调用方。
// 约定：HTTP 一律 200，成败看信封；领域拒绝（EngineReject/DraftReject）用 error code -32000，参数形状不合法 -32602。
// 发现类工具（list_classes / read_class / search / propose_action）可选 space=draft 读工作副本，缺省已发布；
// query / run_action 永远只读已发布快照，且不接受 space。

import { NextResponse } from "next/server";
import { z, ZodError } from "zod";
import { actionRequestSchema, queryRequestSchema } from "@/server/schema/request";
import { affectedNames, mcpDraftOpSchema } from "@/server/schema/ops";
import { runQuery } from "@/server/engine/query";
import { runAction } from "@/server/engine/action";
import { EngineReject } from "@/server/engine/individual";
import { conversionAction } from "@/server/engine/adjudicate";
import { getSlot } from "@/server/engine/llmSlot";
import { listClasses, listClassesDraft, readClass, readClassDraft, search } from "@/server/engine/views";
import { getDriverRegistry, resolveTableInfos } from "@/server/engine/load";
import { applyOp, DraftReject, getDraft, getPublished, getRev } from "@/server/engine/configStore";
import type { OntologyConfig } from "@/server/schema/config";
import { metaStore } from "@/server/meta/store";
import { withActionLog, withQueryLog } from "@/server/engine/logging";
import { BadRequest, requireWriteAuth, wsOf } from "@/app/api/_shared";

const spaceEnum = { type: "string", enum: ["published", "draft"] } as const;
/** apply_draft 的 inputSchema：op 联合由 mcpDraftOpSchema 生成（天然没有 save_layout），再并上必填的 base_rev。 */
const applyDraftInputSchema = {
  ...(z.toJSONSchema(mcpDraftOpSchema) as Record<string, unknown>),
  properties: { base_rev: { type: "integer", minimum: 0, description: "先 list_classes space=draft 拿到的 rev" } },
  required: ["base_rev"],
};

const TOOLS = [
  {
    name: "query",
    description: "按已发布本体查业务数据（只读）。入参：{ query: 查询 JSON }。不接受 space。",
    inputSchema: { type: "object", properties: { query: { type: "object", description: "查询 JSON" } }, required: ["query"] },
  },
  {
    name: "run_action",
    description: "执行一条已发布动作。入参：{ action, object, identity, request? }。不接受 space。",
    inputSchema: {
      type: "object",
      properties: { action: { type: "string" }, object: { type: "string" }, identity: { description: "识别字段的取值" }, request: { type: "object" } },
      required: ["action", "object", "identity"],
    },
  },
  {
    name: "propose_ontology",
    description: "对选中的表产对象建议（不落到画布）。入参：{ tables: [{ connection, table }] }。不接受 space。",
    inputSchema: {
      type: "object",
      properties: {
        tables: { type: "array", items: { type: "object", properties: { connection: { type: "string" }, table: { type: "string" } }, required: ["connection", "table"] } },
      },
      required: ["tables"],
    },
  },
  {
    name: "propose_action",
    description: "对某个类产一条动作建议（不发布、不落到画布）。入参：{ object, space? }。space 缺省 published（已发布）；草稿里尚未发布的类请传 draft。",
    inputSchema: { type: "object", properties: { object: { type: "string" }, space: spaceEnum }, required: ["object"] },
  },
  {
    name: "list_classes",
    description: "列出类的名字和说明。缺省看已发布；要看画布上还没发布的草稿，必须传 space: \"draft\"（返回里带 outlets——告知要发去的系统名列表）。入参：{ space? }。",
    inputSchema: { type: "object", properties: { space: spaceEnum } },
  },
  {
    name: "read_class",
    description: "读一个类的字段、关系、动作。缺省已发布（不含来源表）。改画布请传 space: \"draft\"，会带上来源对照、能不能整份替换（replaceable）和完整动作定义（可读回-改-写回）。入参：{ name, space? }。",
    inputSchema: { type: "object", properties: { name: { type: "string" }, space: spaceEnum }, required: ["name"] },
  },
  {
    name: "search",
    description: "按文本找类名、关系名。缺省已发布；找草稿里的名字请传 space: \"draft\"。入参：{ text, space? }。",
    inputSchema: { type: "object", properties: { text: { type: "string" }, space: spaceEnum }, required: ["text"] },
  },
  {
    name: "list_tables",
    description: "列出已连接库里的表和列（只读列定义，没有采样行，不保存连接）。入参：{ connection? }。不接受 space。",
    inputSchema: { type: "object", properties: { connection: { type: "string" } } },
  },
  {
    name: "apply_draft",
    description:
      "改草稿，一次只改一步。草稿还没发布，问数和已发布动作看不见。入参 { op, ... }，必带 base_rev（先 list_classes space=draft 拿 rev）。op 与草稿编辑同一套：创建/删除对象、增删字段、设认出同一对象靠的字段、创建/删除关系、导入对象、整份替换（未发布且未锁定的类）、设置/删除一条动作（set_action / remove_action）。不能发布、放弃、裁决、回滚，也不能改节点位置。不接受 space。",
    inputSchema: applyDraftInputSchema,
  },
];

const rpcOk = (id: unknown, result: unknown) => NextResponse.json({ jsonrpc: "2.0", id: id ?? null, result });
const rpcErr = (id: unknown, code: number, message: string) => NextResponse.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
/** tools/call 的结果：文本通道 + 结构化通道；isError 标业务失败（前置不满足等）。 */
const toolResult = (payload: unknown, isError = false) => ({
  content: [{ type: "text", text: JSON.stringify(payload) }],
  structuredContent: payload,
  ...(isError ? { isError: true } : {}),
});

const requestSchema = z.object({
  jsonrpc: z.literal("2.0").optional(), // 宽容：不写也收，写了必须是 2.0
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
});

/** apply_draft 的信封：base_rev 必填数字（缺了、或 "12" 这种字符串都 -32602）；其余键原样留给 op 联合 parse。 */
const applyDraftEnvelope = z.looseObject({
  base_rev: z.number().int().nonnegative(),
});

/** 接受 space 的只有这四个发现类工具；其余工具 arguments 里出现 space 键即 -32602（不能假装查了草稿却返回已发布世界）。 */
const SPACE_OK = new Set(["list_classes", "read_class", "search", "propose_action"]);
const spaceSchema = z.enum(["published", "draft"]).optional();

export async function POST(req: Request) {
  let id: unknown = null;
  try {
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return rpcErr(null, -32700, "请求体不是合法 JSON");
    }
    const parsed = requestSchema.safeParse(raw);
    if (!parsed.success) return rpcErr(null, -32600, "不是合法请求：需要 { method, params?, id? }");
    const body = parsed.data;
    id = body.id ?? null;

    if (body.method === "initialize") {
      return rpcOk(id, { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "ontos", version: "0.1.0" } });
    }
    // JSON-RPC 通知不应有响应（Streamable HTTP：202 空体）
    if (body.method.startsWith("notifications/")) return new NextResponse(null, { status: 202 });
    if (body.method === "tools/list") return rpcOk(id, { tools: TOOLS });
    if (body.method !== "tools/call") return rpcErr(id, -32601, `未知方法：${body.method}`);

    const name = body.params?.name as string | undefined;
    if (!name) return rpcErr(id, -32602, "tools/call 缺 params.name");
    const args = (body.params?.arguments ?? {}) as Record<string, unknown>;
    const ws = wsOf(req);
    if ("space" in args && !SPACE_OK.has(name)) {
      return rpcErr(id, -32602, "这个工具不接受 space");
    }
    // 按工具取配置：query / run_action 只读已发布；发现工具缺省已发布、显式 draft 读工作副本
    let space: "published" | "draft" = "published";
    if (SPACE_OK.has(name)) {
      const sp = spaceSchema.safeParse(args.space);
      if (!sp.success) return rpcErr(id, -32602, "space 只认 published 或 draft");
      space = sp.data ?? "published";
    }
    const loadConfig = async (): Promise<OntologyConfig> =>
      space === "draft" ? (await getDraft(ws)).draft : (await getPublished(ws)).config;
    const driver = await getDriverRegistry(ws);

    if (name === "query") {
      const config = (await getPublished(ws)).config; // 问数永远读已发布，不可改成 getDraft
      const query = queryRequestSchema.parse(args.query);
      const out = await withQueryLog(ws, { query_json: JSON.stringify(query) }, () => runQuery(config, driver, query));
      return rpcOk(id, toolResult({ rows: out.rows, path: out.path }));
    }
    if (name === "run_action") {
      const denied = requireWriteAuth(req);
      if (denied) return rpcErr(id, -32001, "未授权：写操作需要有效的令牌");
      const config = (await getPublished(ws)).config; // 动作永远读已发布，不可改成 getDraft
      const action = actionRequestSchema.parse(args);
      const result = await withActionLog(ws, action, () => runAction(config, driver, action, { nextSequence: (k, s) => metaStore().nextSeq(ws, k, s) }));
      // 业务失败（前置/公理/投影）按 MCP 约定标 isError，调用方不用猜
      return rpcOk(id, toolResult(result, !result.ok));
    }
    if (name === "propose_ontology") {
      const tables = z.array(z.object({ connection: z.string(), table: z.string() })).nonempty().parse(args.tables ?? []);
      // 按连接分组内省 + 逐表定位：引擎共享实现（generate 同款）
      const infos = await resolveTableInfos(driver, tables, (m) => new EngineReject(m));
      const draft = await getSlot().draftObjects(infos);
      return rpcOk(id, toolResult({ object_types: draft }));
    }
    if (name === "propose_action") {
      const config = await loadConfig(); // 只改变查找哪份配置，仍是一次出模板、不落地
      const clsName = String(args.object ?? "");
      const cls = config.object_types[clsName];
      if (!cls) throw new EngineReject(`配置中没有类：${clsName}`);
      // 有转化关系就给转化模板，否则给改属性模板；都是草稿，不发布
      const transition = Object.entries(config.link_types).find(([, l]) => l.from === clsName && l.to === clsName && l.transition);
      const draftAction = transition
        ? conversionAction(transition[0], transition[1]) // 转化骨架唯一构造点（adjudicate.ts）
        : {
            description: "更新属性（模板，请改属性名与前置）",
            pre: {},
            effect: [{ update: { object: clsName, identity: { from: "identity" }, properties: { 属性名: { from: "request" } } } }],
          };
      return rpcOk(id, toolResult({ action: draftAction }));
    }
    // 配置三视图：Agent 编请求前按它读，不写死名字（§5.3）。草稿视图带状态/来源对照。
    if (name === "list_classes") {
      if (space === "draft") {
        const state = await getDraft(ws);
        const published = (await getPublished(ws)).config;
        return rpcOk(
          id,
          toolResult({
            space: "draft",
            dirty: state.dirty,
            rev: getRev(ws),
            base_version: state.baseVersion,
            classes: listClassesDraft(state.draft, published),
            outlets: Object.keys(state.draft.outlets ?? {}), // 全局出站名（inform 的合法去向），只读——没有写入 op
          })
        );
      }
      return rpcOk(id, toolResult({ classes: listClasses((await getPublished(ws)).config) }));
    }
    if (name === "read_class") {
      const clsName = String(args.name ?? "");
      if (space === "draft") {
        const state = await getDraft(ws);
        const published = (await getPublished(ws)).config;
        return rpcOk(id, toolResult(readClassDraft(state.draft, published, clsName)));
      }
      return rpcOk(id, toolResult(readClass((await getPublished(ws)).config, clsName)));
    }
    if (name === "search") return rpcOk(id, toolResult(search(await loadConfig(), String(args.text ?? ""))));
    if (name === "list_tables") {
      // 只读列定义（不下发采样行）；按连接 try/catch，一个连接失败不让整个工具变成信封错误
      const conn = args.connection !== undefined ? String(args.connection) : undefined;
      if (conn !== undefined && !driver.has(conn)) {
        return rpcOk(id, toolResult({ sources: [{ connection: conn, tables: [], error: "没有这个连接" }] }));
      }
      const sources = [];
      for (const connection of conn ? [conn] : driver.connectionNames()) {
        try {
          const tables = await driver.introspect(connection);
          sources.push({
            connection,
            tables: tables.map((t) => ({ name: t.name, columns: t.columns.map((c) => ({ name: c.name, type: c.type, pk: c.pk })) })),
          });
        } catch {
          sources.push({ connection, tables: [], error: "连接失败或读取表结构失败" }); // 与 GET /api/introspect 同口径：驱动内部主机/路径不出网
        }
      }
      return rpcOk(id, toolResult({ sources }));
    }
    if (name === "apply_draft") {
      const denied = requireWriteAuth(req);
      if (denied) return rpcErr(id, -32001, "未授权：写操作需要有效的令牌");
      const { base_rev, ...rest } = applyDraftEnvelope.parse(args); // 先剥信封再 parse op（判别联合不收信封字段）
      const op = mcpDraftOpSchema.parse(rest); // 无 save_layout；Zod 失败 -32602
      // 不在路由里比 getRev、不再套一层队列：base_rev 的比较在 applyOp 的 enqueue task 开头
      const next = await applyOp(op, ws, { base_rev });
      return rpcOk(id, toolResult({ ok: true, dirty: next.dirty, rev: getRev(ws), base_version: next.baseVersion, op: op.op, names: affectedNames(op) }));
    }
    return rpcErr(id, -32601, `未知工具：${name}`);
  } catch (e) {
    if (e instanceof ZodError) return rpcErr(id, -32602, "入参形状不合法");
    if (e instanceof BadRequest) return rpcErr(id, -32602, e.message);
    if (e instanceof EngineReject) return rpcErr(id, -32000, e.message);
    if (e instanceof DraftReject) return rpcErr(id, -32000, e.message); // 与 EngineReject 同档（REST 侧是 422）
    return rpcErr(id, -32603, e instanceof Error ? e.message : String(e));
  }
}
