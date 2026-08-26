// 路由共用的小件：请求体解析、错误阶梯（respond）、统一 500、写端点令牌闸。
// 非路由文件（非 route.ts），只被各条 api 路由 import。

import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { DraftReject, EngineReject, ConnectionReject, WorkspaceReject, MSG, logReject } from "@/server/errors";
import { isWorkspaceName } from "@/server/infra/workspace";

/** 请求体不是合法 JSON 时抛它——裸 SyntaxError 落进 catch 会被当成 500。 */
export class BadRequest extends Error {}

export async function bodyJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    throw new BadRequest(MSG.bodyNotJson);
  }
}

/** 「生产不透内部错误细节」的唯一出处：生产给固定文案，明细只在非生产环境给。
 *  REST（internalError）与 MCP（route 的 -32603）同调这一处，不各写一遍闸。 */
export function internalErrorMessage(e: unknown): string {
  return process.env.NODE_ENV === "production" ? MSG.internalError : e instanceof Error ? e.message : String(e);
}

/** 统一的 500 形状：固定文案；detail（内部错误细节）只在非生产环境给，生产不透。 */
export function internalError(e: unknown): NextResponse {
  logReject(e);
  const detail = e instanceof Error ? e.message : String(e);
  return NextResponse.json({ error: MSG.internalError, ...(process.env.NODE_ENV === "production" ? {} : { detail }) }, { status: 500 });
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
      logReject(e);
      const z = opts.zod ?? { status: 400, error: MSG.zodRequestShape };
      return NextResponse.json({ error: z.error, issues: e.issues }, { status: z.status });
    }
    if (e instanceof BadRequest) {
      logReject(e);
      return NextResponse.json({ error: e.message }, { status: 400 });
    }
    if (e instanceof ConnectionReject) {
      logReject(e);
      return NextResponse.json({ error: e.message }, { status: e.kind === "bad_request" ? 400 : 422 });
    }
    if (e instanceof DraftReject || e instanceof EngineReject || e instanceof WorkspaceReject) {
      logReject(e);
      return NextResponse.json({ error: e.message }, { status: 422 });
    }
    return internalError(e);
  }
}

/** 工作空间来自 URL 路径段（/api/<空间名>/…）：Next 动态段经这里校验，名字不合法抛 BadRequest。 */
export async function workspaceOf(params: Promise<{ workspace: string }>): Promise<string> {
  const workspace = (await params).workspace;
  if (!isWorkspaceName(workspace)) throw new BadRequest(MSG.workspaceNameBad(workspace));
  return workspace;
}

/** Result 失败 → HTTP 响应：code 原样当 status（与 HTTP 状态码一致），body 保持 { error: message }。 */
export function rejectRes(r: { code: 400 | 422; message: string }): NextResponse {
  return NextResponse.json({ error: r.message }, { status: r.code });
}

/** 写端点的可选闸门：设了环境变量 ONTOS_TOKEN 才启用（演示默认放开）。
 *  启用后写请求必须带 Authorization: Bearer <token>。返回 null 表示放行。 */
export function requireWriteAuth(req: Request): NextResponse | null {
  const token = process.env.ONTOS_TOKEN;
  if (!token) return null;
  const got = req.headers.get("authorization");
  if (got === `Bearer ${token}`) return null;
  return NextResponse.json({ error: MSG.unauthorizedWrite }, { status: 401 });
}
