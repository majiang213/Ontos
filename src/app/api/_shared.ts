// 路由共用的小件：请求体解析、错误阶梯（respond）、统一 500、写端点令牌闸。
// 非路由文件（非 route.ts），只被各条 api 路由 import。

import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { DraftReject } from "@/server/engine/configStore";
import { EngineReject } from "@/server/engine/individual";
import { ConnectionReject } from "@/server/engine/load";
import { DEFAULT_WS, isWsName, WsReject } from "@/server/engine/workspace";

export { safeLog } from "@/server/engine/logging";

/** 请求体不是合法 JSON 时抛它——裸 SyntaxError 落进 catch 会被当成 500。 */
export class BadRequest extends Error {}

export async function bodyJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new BadRequest("请求体不是合法 JSON");
  }
}

/** 统一的 500 形状：固定文案；detail（内部错误细节）只在非生产环境给，生产不透。 */
export function internalError(e: unknown): NextResponse {
  const detail = e instanceof Error ? e.message : String(e);
  return NextResponse.json({ error: "内部错误", ...(process.env.NODE_ENV === "production" ? {} : { detail }) }, { status: 500 });
}

/**
 * 路由体的唯一包装：错误阶梯独占在这里，路由只剩 parse → 调引擎 → 返回 JSON 体。
 * fn 返回对象按 200 输出；要自定义状态/形状就在 fn 里自己返回 NextResponse（原样透传）。
 * zod 默认落 400；opts.zod 可改（如 publish 的配置不合法落 422）。
 */
export async function respond(fn: () => Promise<unknown>, opts: { zod?: { status: number; error: string } } = {}): Promise<NextResponse> {
  try {
    const out = await fn();
    return out instanceof NextResponse ? out : NextResponse.json(out);
  } catch (e) {
    if (e instanceof ZodError) {
      const z = opts.zod ?? { status: 400, error: "请求形状不合法" };
      return NextResponse.json({ error: z.error, issues: e.issues }, { status: z.status });
    }
    if (e instanceof BadRequest) return NextResponse.json({ error: e.message }, { status: 400 });
    if (e instanceof ConnectionReject) {
      return NextResponse.json({ error: e.message }, { status: e.kind === "bad_request" ? 400 : 422 });
    }
    if (e instanceof DraftReject || e instanceof EngineReject || e instanceof WsReject) return NextResponse.json({ error: e.message }, { status: 422 });
    return internalError(e);
  }
}

/** 工作空间：?ws= 或 x-ontos-ws 头，缺省 default；名字不合法抛 BadRequest。 */
export function wsOf(req: Request): string {
  const url = new URL(req.url);
  const ws = url.searchParams.get("ws") ?? req.headers.get("x-ontos-ws") ?? DEFAULT_WS;
  if (!isWsName(ws)) throw new BadRequest(`空间名不合法：${ws}`);
  return ws;
}

/** 写端点的可选闸门：设了环境变量 ONTOS_TOKEN 才启用（演示默认放开）。
 *  启用后写请求必须带 Authorization: Bearer <token>。返回 null 表示放行。 */
export function requireWriteAuth(req: Request): NextResponse | null {
  const token = process.env.ONTOS_TOKEN;
  if (!token) return null;
  const got = req.headers.get("authorization");
  if (got === `Bearer ${token}`) return null;
  return NextResponse.json({ error: "未授权：写操作需要有效的令牌" }, { status: 401 });
}
