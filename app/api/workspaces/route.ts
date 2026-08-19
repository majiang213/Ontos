// 工作空间：GET 列表 / POST 新建（从种子模板起步）。
// 台账 = 共享元库的 onto_workspace 注册表；各空间的版本链与元数据按 workspace_id 隔离。

import { NextResponse } from "next/server";
import { z, ZodError } from "zod";
import { createWorkspace, listWorkspaces } from "@/lib/engine/workspace";
import { BadRequest, bodyJson, internalError, requireWriteAuth } from "@/app/api/_shared";

export async function GET() {
  try {
    return NextResponse.json({ workspaces: await listWorkspaces() });
  } catch (e) {
    return internalError(e);
  }
}

export async function POST(req: Request) {
  const denied = requireWriteAuth(req);
  if (denied) return denied;
  try {
    const { name } = z.object({ name: z.string().min(1) }).parse(await bodyJson(req));
    await createWorkspace(name);
    return NextResponse.json({ ok: true, workspaces: await listWorkspaces() });
  } catch (e) {
    if (e instanceof ZodError || e instanceof BadRequest) return NextResponse.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
    if (e instanceof Error && (e.message.includes("空间名") || e.message.includes("已存在"))) return NextResponse.json({ error: e.message }, { status: 422 });
    return internalError(e);
  }
}
