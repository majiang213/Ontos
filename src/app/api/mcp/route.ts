// MCP 端点：JSON-RPC 2.0 信封（Streamable HTTP 形态），外部 Agent 经这里调 Ontos 的工具。
// initialize 握手；tools/list 列工具；tools/call 执行。循环不做进 Ontos——外部 Agent 是调用方。
// 约定：HTTP 一律 200，成败看信封；领域拒绝（EngineReject/DraftReject）用 error code -32000，参数形状不合法 -32602。
// 九个工具本身登记在同目录 tools.ts 的注册表里（说明/inputSchema/space/令牌/handler 一份）——本文件只剩信封与调度。

import { NextResponse } from "next/server";
import { z, ZodError } from "zod";
import { EngineReject } from "@/server/errors";
import { DraftReject } from "@/server/errors";
import { getDraft, getPublished } from "@/server/engine/draft/current";
import { getDriverRegistry } from "@/server/engine/infra/load";
import { BadRequest, requireWriteAuth, wsOf } from "@/app/api/_shared";
import { TOOLS, type ToolContext } from "./tools";

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
    if (body.method === "tools/list") return rpcOk(id, { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) });
    if (body.method !== "tools/call") return rpcErr(id, -32601, `未知方法：${body.method}`);

    const name = body.params?.name as string | undefined;
    if (!name) return rpcErr(id, -32602, "tools/call 缺 params.name");
    const args = (body.params?.arguments ?? {}) as Record<string, unknown>;
    const ws = wsOf(req);
    const tool = TOOLS.find((t) => t.name === name);
    if (!tool) return rpcErr(id, -32601, `未知工具：${name}`);
    if ("space" in args && !tool.space) return rpcErr(id, -32602, "这个工具不接受 space"); // 不能假装查了草稿却返回已发布世界
    let space: "published" | "draft" = "published";
    if (tool.space) {
      const sp = spaceSchema.safeParse(args.space);
      if (!sp.success) return rpcErr(id, -32602, "space 只认 published 或 draft");
      space = sp.data ?? "published";
    }
    if (tool.auth) {
      const denied = requireWriteAuth(req);
      if (denied) return rpcErr(id, -32001, "未授权：写操作需要有效的令牌");
    }
    const ctx: ToolContext = {
      ws,
      space,
      driver: await getDriverRegistry(ws),
      config: async () => (space === "draft" ? (await getDraft(ws)).draft : (await getPublished(ws)).config),
      published: async () => (await getPublished(ws)).config,
    };
    const out = await tool.handler(ctx, args);
    return rpcOk(id, toolResult(out.payload, out.isError));
  } catch (e) {
    if (e instanceof ZodError) return rpcErr(id, -32602, "入参形状不合法");
    if (e instanceof BadRequest) return rpcErr(id, -32602, e.message);
    if (e instanceof EngineReject) return rpcErr(id, -32000, e.message);
    if (e instanceof DraftReject) return rpcErr(id, -32000, e.message); // 与 EngineReject 同档（REST 侧是 422）
    return rpcErr(id, -32603, e instanceof Error ? e.message : String(e));
  }
}
