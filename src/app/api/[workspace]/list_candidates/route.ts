// 候选对：GET /api/list_candidates
// 机器在已上画布、有来源的对象之间找候选对（《ontos-article.md》§3.2）。同一库两张表也可以成对。
// 薄适配：空间 → 裁决流水线 listCandidates。

import { engineEnv } from "@/server/runtime";
import { listCandidates } from "@/server/features/integrate/candidates";
import { rejectRes, respond, workspaceOf } from "@/app/api/_shared";

export async function GET(req: Request, { params }: { params: Promise<{ workspace: string }> }) {
  return respond(async () => {
    const r = await listCandidates(engineEnv(), await workspaceOf(params));
    if (r.code !== 200) return rejectRes(r);
    return { candidates: r.value };
  });
}
