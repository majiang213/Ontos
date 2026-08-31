// 交集率：POST /api/compute_overlap { class_a, class_b }
// 薄适配：形状校验 + 写闸 → 裁决流水线 computeOverlap。Agent 经 MCP 同名工具取同一份证据。

import { engineEnv } from "@/server/runtime";
import { computeOverlap } from "@/server/features/integrate/overlap";
import { overlapRequestSchema } from "@/server/schema/request";
import { bodyJson, rejectRes, requireWriteAuth, respond, workspaceOf } from "@/app/api/_shared";

export async function POST(req: Request, { params }: { params: Promise<{ workspace: string }> }) {
  const denied = requireWriteAuth(req); // 触发两列全量扫 + 写计数，口径与写端点对齐
  if (denied) return denied;
  return respond(async () => {
    const { class_a, class_b } = overlapRequestSchema.parse(await bodyJson(req));
    const r = await computeOverlap(engineEnv(), await workspaceOf(params), class_a, class_b);
    if (r.code !== 200) return rejectRes(r);
    return r.value;
  });
}
