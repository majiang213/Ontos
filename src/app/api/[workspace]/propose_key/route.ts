// 识别唯一键：POST /api/propose_key { object }
// 只建议、不落地（propose_ 前缀纪律：落地仍是 edit_draft set_identity）。待确认面板①逐类按钮触发。
// 无 MCP 工具——唯一键确认的关卡留给人。

import { z } from "zod";
import { engineEnv } from "@/server/runtime";
import { proposeKeyFor } from "@/server/features/integrate/proposeKey";
import { bodyJson, rejectRes, respond, workspaceOf } from "@/app/api/_shared";

const bodySchema = z.object({ object: z.string() });

export async function POST(req: Request, { params }: { params: Promise<{ workspace: string }> }) {
  return respond(async () => {
    const { object } = bodySchema.parse(await bodyJson(req));
    const r = await proposeKeyFor(engineEnv(), await workspaceOf(params), object);
    if (r.code !== 200) return rejectRes(r);
    return r.value;
  });
}
