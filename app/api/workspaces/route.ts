// 工作空间：GET 列表 / POST 新建（从种子模板起步）。
// 空间 = lib/config/workspaces/<name>/ 一套配置与元数据；台账就是目录，不建表。

import { NextResponse } from "next/server";
import { z, ZodError } from "zod";
import { createWorkspace, listWorkspaces } from "@/lib/engine/workspace";
import { BadRequest, bodyJson, internalError, requireWriteAuth } from "@/app/api/_shared";

export async function GET() {
  try {
    return NextResponse.json({ workspaces: listWorkspaces() });
  } catch (e) {
    return internalError(e);
  }
}

export async function POST(req: Request) {
  const denied = requireWriteAuth(req);
  if (denied) return denied;
  try {
    const { name } = z.object({ name: z.string().min(1) }).parse(await bodyJson(req));
    createWorkspace(name);
    return NextResponse.json({ ok: true, workspaces: listWorkspaces() });
  } catch (e) {
    if (e instanceof ZodError || e instanceof BadRequest) return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
    if (e instanceof Error && (e.message.includes("空间名") || e.message.includes("已存在"))) return NextResponse.json({ error: e.message }, { status: 422 });
    return internalError(e);
  }
}
