// 识别唯一键：POST /api/propose_key { object }
// 只建议、不落地（propose_ 前缀纪律：落地仍是 edit_draft set_identity）。画布已无此按钮，入口是 Agent 经 MCP 同名工具。

import { engineEnv } from "@/server/runtime";
import { proposeKeyFor } from "@/server/features/integrate/proposeKey";
import { proposeKeyRequestSchema } from "@/server/schema/request";
import { bodyJson, rejectRes, respond, workspaceOf } from "@/app/api/_shared";

export async function POST(req: Request, { params }: { params: Promise<{ workspace: string }> }) {
  return respond(async () => {
    const { object } = proposeKeyRequestSchema.parse(await bodyJson(req));
    const r = await proposeKeyFor(engineEnv(), await workspaceOf(params), object);
    if (r.code !== 200) return rejectRes(r);
    return r.value;
  });
}
