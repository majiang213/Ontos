// 路由共用的小件：请求体解析、尽力留痕、统一 500、写端点令牌闸。
// 非路由文件（非 route.ts），只被各条 api 路由 import。

import { NextResponse } from "next/server";
import { DEFAULT_WS, isWsName } from "@/lib/engine/workspace";

/** 请求体不是合法 JSON 时抛它——裸 SyntaxError 落进 catch 会被当成 500。 */
export class BadRequest extends Error {}

export async function bodyJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new BadRequest("请求体不是合法 JSON");
  }
}

/** 留痕尽力而为（可同步可异步）：500 的根因若正是元库故障，catch 里再抛就成非 JSON 响应。 */
export function safeLog(fn: () => void | Promise<void>): void {
  try {
    void Promise.resolve(fn()).catch(() => {});
  } catch {
    // 留痕失败不挡响应
  }
}

/** 统一的 500 形状：固定文案；detail（内部错误细节）只在非生产环境给，生产不透。 */
export function internalError(e: unknown): NextResponse {
  const detail = e instanceof Error ? e.message : String(e);
  return NextResponse.json({ error: "内部错误", ...(process.env.NODE_ENV === "production" ? {} : { detail }) }, { status: 500 });
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
