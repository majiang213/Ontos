// 本体视图：GET /api/ontology
// 画布读工作副本（已发布 + 未发布改动）；引擎读已发布快照（见 lib/engine/configStore.ts 的 getPublished）。
// states 标出每个对象的草稿态：new=未发布的新对象，modified=与已发布不同，same=一致。

import { NextResponse } from "next/server";
import { getDraft, getPublished, sameConfig } from "@/server/engine/configStore";
import { internalError, wsOf } from "@/app/api/_shared";

export async function GET(req: Request) {
  try {
    const ws = wsOf(req);
    const state = await getDraft(ws);
    const published = (await getPublished(ws)).config;
    const states: Record<string, "new" | "modified" | "same"> = {};
    for (const [name, t] of Object.entries(state.draft.object_types)) {
      const pub = published.object_types[name];
      states[name] = !pub ? "new" : sameConfig(pub, t) ? "same" : "modified";
    }
    // 已发布但草稿里删掉的对象：给画布一个「待删除」名单
    const deleted = Object.keys(published.object_types).filter((name) => !(name in state.draft.object_types));
    return NextResponse.json({
      version: state.baseVersion,
      dirty: state.dirty,
      layout: state.layout,
      states,
      deleted,
      object_types: state.draft.object_types,
      link_types: state.draft.link_types,
      outlets: state.draft.outlets ?? {},
    });
  } catch (e) {
    return internalError(e);
  }
}
