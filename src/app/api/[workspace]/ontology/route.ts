// 本体视图：GET /api/ontology
// 画布读工作副本（已发布 + 未发布改动）；引擎读已发布快照（见 src/server/features/ontology/current.ts 的 getPublished）。
// states 标出每个对象的草稿态：new=未发布的新对象，modified=与已发布不同，same=一致。
// rev + ETag 供画布轮询当监视器：内容没变回 304。200 与 304 都带 Cache-Control: no-store——
// 缺了它浏览器可能把 200 缓存起来，轮询就看不见外部（MCP）写入。

import { NextResponse } from "next/server";
import { engineEnv } from "@/server/runtime";
import { getDraft, getPublished, getRev } from "@/server/features/ontology/current";
import { draftDiff } from "@/server/features/ontology/views";
import { etagOf } from "@/server/etag";
import { respond, workspaceOf } from "@/app/api/_shared";

export async function GET(req: Request, { params }: { params: Promise<{ workspace: string }> }) {
  return respond(async () => {
    const workspace = await workspaceOf(params);
    const env = engineEnv();
    const state = await getDraft(env, workspace);
    const rev = await getRev(env, workspace);
    const etag = etagOf(workspace, rev);
    const headers = { ETag: etag, "Cache-Control": "no-store" };
    if (req.headers.get("if-none-match") === etag) {
      return new NextResponse(null, { status: 304, headers });
    }
    const published = (await getPublished(env, workspace)).config;
    const { states, deleted, action_changes } = draftDiff(state.draft, published);
    return NextResponse.json(
      {
        rev,
        version: state.baseVersion,
        dirty: state.dirty,
        layout: state.layout,
        edgeBends: state.edgeBends,
        edgePins: state.edgePins,
        states,
        deleted,
        action_changes,
        object_types: state.draft.object_types, // actions 保持完整 ActionDef——对象卡从 def 在前端算摘要
        link_types: state.draft.link_types,
      },
      { headers }
    );
  });
}
