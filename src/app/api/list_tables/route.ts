// M1 连接器：GET /api/list_tables
// 读驱动注册表里每个连接的表结构 + 3 行脱敏采样（引擎原语 infra/load.listTables）。源表是只读原料。

import { getDriverRegistry } from "@/server/engine/infra/connections";
import { listTables } from "@/server/engine/infra/tables";
import { respond, wsOf } from "@/app/api/_shared";

export async function GET(req: Request) {
  return respond(async () => {
    const registry = await getDriverRegistry(wsOf(req));
    return { sources: await listTables(registry, { sample: 3 }) };
  });
}
