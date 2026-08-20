// MCP 端点：JSON-RPC 2.0 信封（Streamable HTTP 形态），外部 Agent 经这里调 Ontos 的工具。
// initialize 握手；tools/list 列工具；tools/call 执行。循环不做进 Ontos——外部 Agent 是调用方。
// 约定：HTTP 一律 200，成败看信封；领域拒绝（EngineReject）用 error code -32000，参数形状不合法 -32602。

import { NextResponse } from "next/server";
import { z, ZodError } from "zod";
import { actionRequestSchema, queryRequestSchema } from "@/server/schema/request";
import { runQuery } from "@/server/engine/query";
import { runAction } from "@/server/engine/action";
import { EngineReject } from "@/server/engine/individual";
import { getSlot } from "@/server/engine/llmSlot";
import { listClasses, readClass, search } from "@/server/engine/views";
import { getDriverRegistry, resolveTableInfos } from "@/server/engine/load";
import { getPublished } from "@/server/engine/configStore";
import { metaStore } from "@/server/meta/store";
import { withActionLog, withQueryLog } from "@/server/engine/logging";
import { BadRequest, requireWriteAuth, wsOf } from "@/app/api/_shared";

const TOOLS = [
  { name: "query", description: "按已发布本体执行结构化查询（只读）。入参：{ query: 查询 JSON }" },
  { name: "run_action", description: "执行一条已发布动作。入参：{ action, object, identity, request? }" },
  { name: "propose_ontology", description: "对选中的表产本体草稿建议（不落画布）。入参：{ tables: [{ connection, table }] }" },
  { name: "propose_action", description: "对某类产一条动作定义草稿（不发布）。入参：{ object }" },
  { name: "list_classes", description: "列出本体里全部的类（名字与说明）。入参：{}" },
  { name: "read_class", description: "读取一个类的属性、关系、动作视图。入参：{ name }" },
  { name: "search", description: "按文本检索相关的类名与关系名。入参：{ text }" },
];

const rpcOk = (id: unknown, result: unknown) => NextResponse.json({ jsonrpc: "2.0", id: id ?? null, result });
const rpcErr = (id: unknown, code: number, message: string) => NextResponse.json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
/** tools/call 的结果：文本通道 + 结构化通道；isError 标业务失败（前置不满足等），与 /api/action 的 422 同语义。 */
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
    const config = (await getPublished(ws)).config;
    const driver = await getDriverRegistry(ws);

    if (name === "query") {
      const query = queryRequestSchema.parse(args.query);
      const out = await withQueryLog(ws, { query_json: JSON.stringify(query) }, () => runQuery(config, driver, query));
      return rpcOk(id, toolResult({ rows: out.rows, path: out.path }));
    }
    if (name === "run_action") {
      const denied = requireWriteAuth(req);
      if (denied) return rpcErr(id, -32001, "未授权：写操作需要有效的令牌");
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
      const clsName = String(args.object ?? "");
      const cls = config.object_types[clsName];
      if (!cls) throw new EngineReject(`配置中没有类：${clsName}`);
      // 有转化关系就给转化模板，否则给改属性模板；都是草稿，不发布
      const transition = Object.entries(config.link_types).find(([, l]) => l.from === clsName && l.to === clsName && l.transition);
      const draft = transition
        ? {
            description: `转化为${transition[1].transition!.to}`,
            pre: { [transition[1].transition!.property]: transition[1].transition!.from, $link: { [transition[0]]: false } },
            effect: [{ link: transition[0] }],
          }
        : {
            description: "更新属性（模板，请改属性名与前置）",
            pre: {},
            effect: [{ update: { object: clsName, identity: { from: "identity" }, properties: { 属性名: { from: "request" } } } }],
          };
      return rpcOk(id, toolResult({ action: draft }));
    }
    // 配置三视图：Agent 编请求前按它读，不写死名字（§5.3）
    if (name === "list_classes") return rpcOk(id, toolResult({ classes: listClasses(config) }));
    if (name === "read_class") return rpcOk(id, toolResult(readClass(config, String(args.name ?? ""))));
    if (name === "search") return rpcOk(id, toolResult(search(config, String(args.text ?? ""))));
    return rpcErr(id, -32601, `未知工具：${name}`);
  } catch (e) {
    if (e instanceof ZodError) return rpcErr(id, -32602, "入参形状不合法");
    if (e instanceof BadRequest) return rpcErr(id, -32602, e.message);
    if (e instanceof EngineReject) return rpcErr(id, -32000, e.message);
    return rpcErr(id, -32603, e instanceof Error ? e.message : String(e));
  }
}
