// 工作副本编辑：POST /api/draft
// 薄适配：zod 校验操作形状 → 作用于草稿。形状不合法 400；操作不合法（重名、不存在、被引用等）422。

import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { draftOpSchema } from "@/lib/schema/ops";
import { applyOp, DraftReject } from "@/lib/engine/configStore";
import { BadRequest, bodyJson, internalError, requireWriteAuth, wsOf } from "@/app/api/_shared";

export async function POST(req: Request) {
  const denied = requireWriteAuth(req);
  if (denied) return denied;
  try {
    const op = draftOpSchema.parse(await bodyJson(req));
    const state = applyOp(op, wsOf(req));
    return NextResponse.json({ ok: true, dirty: state.dirty });
  } catch (e) {
    if (e instanceof ZodError) return NextResponse.json({ error: "操作形状不合法", issues: e.issues }, { status: 400 });
    if (e instanceof BadRequest) return NextResponse.json({ error: e.message }, { status: 400 });
    if (e instanceof DraftReject) return NextResponse.json({ error: e.message }, { status: 422 });
    return internalError(e);
  }
}
