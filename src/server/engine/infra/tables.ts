// 表结构发现 —— 「表结构怎么读到」：按连接分组内省、逐表定位（resolveTableInfos）与逐连接列表（listTables）。
// 只读列定义，不取业务行；REST 与 MCP 同走这里。

import type { DriverRegistry } from "./registry";
import type { TableInfo } from "./driver";
import { MSG } from "../../errors";

/** 按连接分组内省、逐表定位（每个连接只内省一次）。找不到表时抛 notFound 产出的错误（调用方定错误类型）。 */
export async function resolveTableInfos(
  registry: DriverRegistry,
  tables: { connection: string; table: string }[],
  notFound: (msg: string) => Error
): Promise<{ connection: string; table: TableInfo }[]> {
  const byConn = new Map<string, TableInfo[]>();
  for (const { connection } of tables) {
    if (!byConn.has(connection)) byConn.set(connection, await registry.introspect(connection));
  }
  return tables.map(({ connection, table }) => {
    const info = byConn.get(connection)!.find((t) => t.name === table);
    if (!info) throw notFound(MSG.tableNotFound(connection, table));
    return { connection, table: info };
  });
}

/** 逐连接读表结构：单连接失败降级为 error 条目，不让整个调用变成信封错误；驱动报错可能含主机/路径，不原样出网。
 *  REST（list_tables）与 MCP（list_tables 工具）共用这一处；sample 给了才按表附采样行。 */
export async function listTables(
  registry: DriverRegistry,
  opts: { connection?: string; sample?: number } = {}
): Promise<{ connection: string; tables: (TableInfo & { sample?: Record<string, unknown>[] })[]; error?: string }[]> {
  if (opts.connection !== undefined && !registry.has(opts.connection)) {
    return [{ connection: opts.connection, tables: [], error: "没有这个连接" }];
  }
  const out: { connection: string; tables: (TableInfo & { sample?: Record<string, unknown>[] })[]; error?: string }[] = [];
  for (const connection of opts.connection ? [opts.connection] : registry.connectionNames()) {
    try {
      const tables = await registry.introspect(connection);
      out.push({
        connection,
        tables: await Promise.all(
          tables.map(async (t) => (opts.sample ? { ...t, sample: await registry.sample(connection, t.name, opts.sample).catch(() => []) } : t))
        ),
      });
    } catch {
      out.push({ connection, tables: [], error: "连接失败或读取表结构失败" });
    }
  }
  return out;
}
