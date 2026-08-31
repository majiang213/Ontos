// 看过交集率之后再给倾向：POST /api/propose_pair { class_a, class_b, rate, count_a, count_b, count_hit }
// 只建议、不落地。比率由 compute_overlap 算好传入；本路由不当计算器。入口是 Agent 经 MCP 同名工具。

import { engineEnv } from "@/server/runtime";
import { proposePair } from "@/server/features/integrate/advise";
import { pairAdviceRequestSchema } from "@/server/schema/request";
import { bodyJson, rejectRes, respond, workspaceOf } from "@/app/api/_shared";

export async function POST(req: Request, { params }: { params: Promise<{ workspace: string }> }) {
  return respond(async () => {
    const { class_a, class_b, rate, count_a, count_b, count_hit } = pairAdviceRequestSchema.parse(await bodyJson(req));
    const r = await proposePair(engineEnv(), await workspaceOf(params), class_a, class_b, { rate, count_a, count_b, count_hit });
    if (r.code !== 200) return rejectRes(r);
    return r.value;
  });
}
