// 候选对：GET /api/list_candidates
// 机器只在已上画布的对象之间找跨源候选对（《ontos-article.md》§3.2）。
// 薄适配：空间 → 裁决流水线 listCandidates。

import { listCandidates } from "@/server/engine/adjudication/pairs";
import { respond, wsOf } from "@/app/api/_shared";

export async function GET(req: Request) {
  return respond(async () => ({ candidates: await listCandidates(wsOf(req)) }));
}
