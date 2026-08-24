// 工作空间：GET 列表 / POST 新建（从种子模板起步）。
// 台账 = 共享元库的 onto_workspace 注册表；各空间的版本链与元数据按 workspace_id 隔离。

import { z } from "zod";
import { createWorkspace, listWorkspaces } from "@/server/engine/infra/workspace";
import { bodyJson, requireWriteAuth, respond } from "@/app/api/_shared";

export async function GET() {
  return respond(async () => ({ workspaces: await listWorkspaces() }));
}

export async function POST(req: Request) {
  const denied = requireWriteAuth(req);
  if (denied) return denied;
  return respond(async () => {
    const { name } = z.object({ name: z.string().min(1) }).parse(await bodyJson(req));
    await createWorkspace(name);
    return { ok: true, workspaces: await listWorkspaces() };
  });
}
