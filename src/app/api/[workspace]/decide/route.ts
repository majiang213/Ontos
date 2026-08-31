// 裁决：POST /api/decide
// 画布操作者或 Agent（经 MCP 同名工具）发起；发布才是人的关卡。薄适配：形状校验 + 写闸 → 裁决流水线 decide。GET 列出留痕。

import { engineEnv } from "@/server/runtime";
import { decide } from "@/server/features/integrate/decide";
import { decideRequestSchema } from "@/server/schema/request";
import { metaStore } from "@/server/meta/store";
import { bodyJson, rejectRes, requireWriteAuth, respond, workspaceOf } from "@/app/api/_shared";

export async function GET(req: Request, { params }: { params: Promise<{ workspace: string }> }) {
  return respond(async () => ({ decisions: await metaStore().listDecisions(await workspaceOf(params)) }));
}

export async function POST(req: Request, { params }: { params: Promise<{ workspace: string }> }) {
  const denied = requireWriteAuth(req);
  if (denied) return denied;
  return respond(async () => {
    const input = decideRequestSchema.parse(await bodyJson(req));
    const r = await decide(engineEnv(), { ...input, decided_by: input.decided_by ?? "画布操作者" }, await workspaceOf(params));
    if (r.code !== 200) return rejectRes(r);
    return r.value;
  });
}
