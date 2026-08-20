// 驱动注册表 —— 全部路由的唯一驱动入口：fixture 内置连接 + 元数据库里保存的连接（mysql/pg/sqlite 文件）。
// 单例挂 globalThis：Next dev 下各路由包各有模块实例，挂全局才能保证
// 「验收之后再问，看到的是同一个源库」「连接保存后即时生效」。
// （已发布配置的加载在 configStore.ts：getPublished。）

import { existsSync, statSync } from "node:fs";
import type { SourceDriver, TableInfo } from "./driver";
import { SqliteFixtureDriver } from "./fixture";
import { DriverRegistry } from "./registry";
import { makeSqlDriver } from "./sqlDriver";
import { metaStore } from "../meta/store";
import { runtime } from "../runtime";
import { DEFAULT_WS } from "./workspace";

// 注册表按工作空间键控，挂运行态（runtime.ts）：Next dev 多模块实例共享，测试换运行态即隔离
function registries(): Map<string, DriverRegistry> {
  return (runtime().registries ??= new Map());
}

/** 驱动注册表（全部路由的唯一驱动入口）：该空间元数据库里保存的连接；演示 fixture 四个内置连接只注入 default——新空间空白起步，数据源自己接。按工作空间键控。 */
export async function getDriverRegistry(ws: string = DEFAULT_WS): Promise<DriverRegistry> {
  let r = registries().get(ws);
  if (!r) {
    const registry = new DriverRegistry();
    if (ws === DEFAULT_WS) {
      const fixture = SqliteFixtureDriver.seeded();
      for (const conn of fixture.connections()) registry.register(conn, fixture);
    }
    for (const rec of await metaStore().listConnections(ws)) registerSaved(registry, rec);
    r = registry;
    registries().set(ws, r);
  }
  return r;
}

/** 把元数据库里的连接注册成驱动。新保存的连接在运行时也走这里（即时生效）。
 *  sqlite 文件必须已存在且不是目录——文件没了（被删/被移走）就跳过这个连接，不拖垮整个注册表。 */
export function registerSaved(registry: DriverRegistry, rec: { name: string; type: string; host?: string; port?: number; db_name?: string; ro_user?: string; ro_pass?: string; rw_user?: string; rw_pass?: string }): void {
  if (rec.type === "sqlite") {
    // SQLite 文件库：db_name 是文件路径
    const p = rec.db_name;
    if (!p || !existsSync(p) || !statSync(p).isFile()) {
      console.warn(`[ontos] 连接 ${rec.name} 的 sqlite 文件不存在，跳过注册：${p}`);
      return;
    }
    const d = new SqliteFixtureDriver();
    d.registerFile(rec.name, p);
    registry.register(rec.name, d);
  } else {
    registry.register(rec.name, makeSqlDriver({ type: rec.type, host: rec.host, port: rec.port, db_name: rec.db_name, ro_user: rec.ro_user, ro_pass: rec.ro_pass, rw_user: rec.rw_user, rw_pass: rec.rw_pass }));
  }
}

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
    if (!info) throw notFound(`表不存在：${connection}.${table}`);
    return { connection, table: info };
  });
}

/** 测试用：每次拿全新的 fixture（不经注册表）。 */
export function freshDriver(): SourceDriver {
  return SqliteFixtureDriver.seeded();
}
