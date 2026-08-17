// 工作副本编辑：POST /api/draft
// 薄适配：zod 校验操作形状 → 作用于草稿。形状不合法 400；操作不合法（重名、不存在、被引用等）422。

import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { draftOpSchema } from "@/lib/schema/ops";
import { applyOp, DraftReject } from "@/lib/engine/configStore";

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "请求体不是合法 JSON" }, { status: 400 });
  }
  try {
    const op = draftOpSchema.parse(body);
    const state = applyOp(op);
    return NextResponse.json({ ok: true, dirty: state.dirty });
  } catch (e) {
    if (e instanceof ZodError) return NextResponse.json({ error: "操作形状不合法", issues: e.issues }, { status: 400 });
    if (e instanceof DraftReject) return NextResponse.json({ error: e.message }, { status: 422 });
    return NextResponse.json({ error: "引擎内部错误", detail: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}
