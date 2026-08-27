// 看过交集率之后再给倾向：POST /api/propose_pair { class_a, class_b, rate, count_a, count_b, count_hit }
// 只建议、不落地。比率由 compute_overlap 算好传入；本路由不当计算器。无 MCP 工具——关卡留给人。

import { z } from "zod";
import { engineEnv } from "@/server/runtime";
import { proposePair } from "@/server/features/integrate/advise";
import { MSG } from "@/server/errors";
import { bodyJson, rejectRes, respond, workspaceOf } from "@/app/api/_shared";

const bodySchema = z
  .object({
    class_a: z.string(),
    class_b: z.string(),
    rate: z.number().min(0).max(1),
    count_a: z.number().int().nonnegative(),
    count_b: z.number().int().nonnegative(),
    count_hit: z.number().int().nonnegative(),
  })
  .refine((b) => b.class_a !== b.class_b, { message: MSG.pairSelfAdvise });

export async function POST(req: Request, { params }: { params: Promise<{ workspace: string }> }) {
  return respond(async () => {
    const { class_a, class_b, rate, count_a, count_b, count_hit } = bodySchema.parse(await bodyJson(req));
    const r = await proposePair(engineEnv(), await workspaceOf(params), class_a, class_b, { rate, count_a, count_b, count_hit });
    if (r.code !== 200) return rejectRes(r);
    return r.value;
  });
}
