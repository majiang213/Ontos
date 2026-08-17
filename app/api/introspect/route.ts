// M1 连接器：GET /api/introspect
// 读驱动注册表里每个连接的表结构 + 3 行脱敏采样。源表是只读原料。

import { NextResponse } from "next/server";
import { demoDriver } from "@/lib/engine/load";

export async function GET() {
  const registry = demoDriver();
  const sources = [];
  for (const connection of registry.connectionNames()) {
    try {
      const tables = await registry.introspect(connection);
      const withSample = await Promise.all(
        tables.map(async (t) => ({ ...t, sample: await registry.sample(connection, t.name, 3).catch(() => []) }))
      );
      sources.push({ connection, tables: withSample });
    } catch (e) {
      sources.push({ connection, tables: [], error: e instanceof Error ? e.message : String(e) });
    }
  }
  return NextResponse.json({ sources });
}
