// 裁决：POST /api/decide
// 定案只能是人。薄适配：形状校验 + 写闸 → 裁决流水线 decide。GET 列出留痕。

import { z } from "zod";
import { engineEnv } from "@/server/runtime";
import { decide } from "@/server/features/integrate/decide";
import { Verdict } from "@/server/schema/verdict";
import { metaStore } from "@/server/meta/store";
import { MSG } from "@/server/errors";
import { bodyJson, rejectRes, requireWriteAuth, respond, workspaceOf } from "@/app/api/_shared";

const bodySchema = z
  .object({
    class_a: z.string(),
    class_b: z.string(),
    verdict: z.enum(Verdict),
    stage_names: z.object({ from: z.string(), to: z.string() }).optional(),
    llm_advice: z.string().optional(),
    evidence: z
      .object({
        norm_rule: z.string().optional(),
        count_a: z.number().optional(),
        count_b: z.number().optional(),
        count_hit: z.number().optional(),
        rate: z.number().optional(),
      })
      .optional(),
    decided_by: z.string().default("画布操作者"),
  })
  .refine((b) => b.class_a !== b.class_b, { message: MSG.pairSelfDecide });

export async function GET(req: Request, { params }: { params: Promise<{ workspace: string }> }) {
  return respond(async () => ({ decisions: await metaStore().listDecisions(await workspaceOf(params)) }));
}

export async function POST(req: Request, { params }: { params: Promise<{ workspace: string }> }) {
  const denied = requireWriteAuth(req);
  if (denied) return denied;
  return respond(async () => {
    const r = await decide(engineEnv(), bodySchema.parse(await bodyJson(req)), await workspaceOf(params));
    if (r.code !== 200) return rejectRes(r);
    return r.value;
  });
}
