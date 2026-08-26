// 连接表单的 sqlite 文件选择器数据源：列出演示库目录（.ontos-demo）里可连接的 .db 文件，
// 带建议连接名（DEMO_SYSTEMS 命中优先）与「本空间已连接」标记。只列文件名与建议名，不读文件内容。

import { join } from "node:path";
import { runtime } from "@/server/runtime";
import { metaStore } from "@/server/meta/store";
import { listSqliteFiles } from "@/server/infra/connections";
import { DEMO_DIR_REL } from "@/server/infra/demoSystems";
import { respond, workspaceOf } from "@/app/api/_shared";

export async function GET(req: Request, { params }: { params: Promise<{ workspace: string }> }) {
  return respond(async () => {
    const workspace = await workspaceOf(params);
    const connected = new Set((await metaStore().listConnections(workspace)).map((c) => c.name));
    const files = listSqliteFiles(join(runtime().cwd, DEMO_DIR_REL)).map((f) => ({ ...f, connected: connected.has(f.connection) }));
    return { files };
  });
}
