// M1 连接器：GET /api/introspect
// 读驱动注册表里每个连接的表结构 + 3 行脱敏采样。源表是只读原料。

import { NextResponse } from "next/server";
import { getDriverRegistry } from "@/lib/engine/load";
import { internalError } from "@/app/api/_shared";

export async function GET() {
  try {
    const registry = getDriverRegistry();
    const sources = [];
    for (const connection of registry.connectionNames()) {
      try {
        const tables = await registry.introspect(connection);
        const withSample = await Promise.all(
          tables.map(async (t) => ({ ...t, sample: await registry.sample(connection, t.name, 3).catch(() => []) }))
        );
        sources.push({ connection, tables: withSample });
      } catch {
        sources.push({ connection, tables: [], error: "连接失败或读取表结构失败" }); // 驱动报错可能含主机/路径，不原样出网
      }
    }
    return NextResponse.json({ sources });
  } catch (e) {
    return internalError(e);
  }
}
