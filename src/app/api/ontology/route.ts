// 本体视图：GET /api/ontology
// 画布读工作副本（已发布 + 未发布改动）；引擎读已发布快照（见 src/server/engine/configStore.ts 的 getPublished）。
// states 标出每个对象的草稿态：new=未发布的新对象，modified=与已发布不同，same=一致。
// rev + ETag 供画布轮询当监视器：内容没变回 304。200 与 304 都带 Cache-Control: no-store——
// 缺了它浏览器可能把 200 缓存起来，轮询就看不见外部（MCP）写入。

import { NextResponse } from "next/server";
import { getDraft, getPublished, getRev, sameConfig } from "@/server/engine/configStore";
import { respond, wsOf } from "@/app/api/_shared";

export async function GET(req: Request) {
  return respond(async () => {
    const ws = wsOf(req);
    const state = await getDraft(ws);
    const rev = getRev(ws);
    const etag = `"${ws}-${rev}"`;
    const headers = { ETag: etag, "Cache-Control": "no-store" };
    if (req.headers.get("if-none-match") === etag) {
      return new NextResponse(null, { status: 304, headers });
    }
    const published = (await getPublished(ws)).config;
    const states: Record<string, "new" | "modified" | "same"> = {};
    for (const [name, t] of Object.entries(state.draft.object_types)) {
      const pub = published.object_types[name];
      states[name] = !pub ? "new" : sameConfig(pub, t) ? "same" : "modified";
    }
    // 已发布但草稿里删掉的对象：给画布一个「待删除」名单
    const deleted = Object.keys(published.object_types).filter((name) => !(name in state.draft.object_types));
    // 动作差集（类名.动作名）：只在草稿=新增；两边都有但结构不同=已修改；只在已发布=去掉。发布条与 toast 只读这个
    const action_changes = { added: [] as string[], overwritten: [] as string[], removed: [] as string[] };
    for (const cls of new Set([...Object.keys(state.draft.object_types), ...Object.keys(published.object_types)])) {
      const da = state.draft.object_types[cls]?.actions ?? {};
      const pa = published.object_types[cls]?.actions ?? {};
      for (const n of Object.keys(da)) {
        if (!(n in pa)) action_changes.added.push(`${cls}.${n}`);
        else if (!sameConfig(da[n], pa[n])) action_changes.overwritten.push(`${cls}.${n}`);
      }
      for (const n of Object.keys(pa)) if (!(n in da)) action_changes.removed.push(`${cls}.${n}`);
    }
    return NextResponse.json(
      {
        rev,
        version: state.baseVersion,
        dirty: state.dirty,
        layout: state.layout,
        states,
        deleted,
        action_changes,
        object_types: state.draft.object_types, // actions 保持完整 ActionDef——对象卡从 def 在前端算摘要
        link_types: state.draft.link_types,
        outlets: state.draft.outlets ?? {},
      },
      { headers }
    );
  });
}
