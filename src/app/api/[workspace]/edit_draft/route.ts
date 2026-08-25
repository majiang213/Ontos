// 工作副本编辑：POST /api/edit_draft
// 薄适配：zod 校验操作形状 → 作用于草稿。形状不合法 400；操作不合法（重名、不存在、被引用等）422。

import { draftOpSchema } from "@/server/schema/ops";
import { engineEnv } from "@/server/runtime";
import { editDraft } from "@/server/features/ontology/editDraft";
import { MSG } from "@/server/errors";
import { bodyJson, rejectRes, requireWriteAuth, respond, workspaceOf } from "@/app/api/_shared";

export async function POST(req: Request, { params }: { params: Promise<{ workspace: string }> }) {
  const denied = requireWriteAuth(req);
  if (denied) return denied;
  return respond(async () => {
    const op = draftOpSchema.parse(await bodyJson(req));
    const r = await editDraft(engineEnv(), op, await workspaceOf(params));
    if (r.code !== 200) return rejectRes(r);
    return { ok: true, dirty: r.value.dirty };
  }, { zod: { status: 400, error: MSG.zodOpShape } });
}
