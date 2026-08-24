// 工作副本编辑：POST /api/apply_draft
// 薄适配：zod 校验操作形状 → 作用于草稿。形状不合法 400；操作不合法（重名、不存在、被引用等）422。

import { draftOpSchema } from "@/server/schema/ops";
import { applyDraft } from "@/server/engine/config/configStore";
import { bodyJson, requireWriteAuth, respond, wsOf } from "@/app/api/_shared";

export async function POST(req: Request) {
  const denied = requireWriteAuth(req);
  if (denied) return denied;
  return respond(async () => {
    const op = draftOpSchema.parse(await bodyJson(req));
    const state = await applyDraft(op, wsOf(req));
    return { ok: true, dirty: state.dirty };
  }, { zod: { status: 400, error: "操作形状不合法" } });
}
