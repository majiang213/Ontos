// 发布与放弃：POST /api/publish 发布（升版本、写版本文件）；DELETE /api/publish 放弃（回退到已发布快照）。
// 引擎只读已发布版本，发布后立即可查。配置不合法 422；写盘等自身故障 500。

import { NextResponse } from "next/server";
import { discardDraft, DraftReject, publishDraft } from "@/lib/engine/configStore";
import { ZodError } from "zod";

export async function POST() {
  try {
    const { version } = publishDraft();
    return NextResponse.json({ ok: true, version });
  } catch (e) {
    if (e instanceof ZodError) return NextResponse.json({ error: "配置结构不合法", issues: e.issues }, { status: 422 });
    if (e instanceof DraftReject) return NextResponse.json({ error: e.message }, { status: 422 });
    if (e instanceof Error && e.message.startsWith("配置不合法")) return NextResponse.json({ error: e.message }, { status: 422 });
    return NextResponse.json({ error: "发布失败", detail: e instanceof Error ? e.message : String(e) }, { status: 500 });
  }
}

export async function DELETE() {
  discardDraft();
  return NextResponse.json({ ok: true });
}
