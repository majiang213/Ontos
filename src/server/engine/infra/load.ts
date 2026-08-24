// 驱动注册表 —— 全部路由的唯一驱动入口：fixture 内置连接 + 元数据库里保存的连接（mysql/pg/sqlite 文件）。
// 保存/删除生命周期也在这里：测过才落库、失败还回旧驱动、已发布引用不可删。
// 单例挂运行态：Next dev 下各路由包各有模块实例，挂全局才能保证即时生效。

import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { ConnectionRec } from "../../meta/types";
import { metaStore } from "../../meta/store";
import { runtime } from "../../runtime";
import { getPublished } from "../config/configStore";
import type { SourceDriver, TableInfo } from "./driver";
import { SqliteFixtureDriver } from "./fixture";
import { SqliteDriver } from "./sqliteDriver";
import { DriverRegistry } from "./registry";
import { makeSqlDriver } from "./sqlDriver";
import { ConnectionReject } from "../../errors";
import { DEFAULT_WS, TEST_WS } from "./workspace";

// 注册表按工作空间键控，挂运行态（runtime.ts）：Next dev 多模块实例共享，测试换运行态即隔离
function registries(): Map<string, DriverRegistry> {
  return (runtime().registries ??= new Map());
}

/** 驱动注册表（全部路由的唯一驱动入口）：该空间元数据库里保存的连接；演示 fixture 四个内置连接只注入 test——其余空间（含 default）空白起步，数据源自己接。按工作空间键控，与 LLM Key 无关。 */
export async function getDriverRegistry(ws: string = DEFAULT_WS): Promise<DriverRegistry> {
  let r = registries().get(ws);
  if (!r) {
    const registry = new DriverRegistry();
    if (ws === TEST_WS) {
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
    // 用户接入的 sqlite 文件库：裸 SqliteDriver——生产路径不背演示机器（种子/注释/剧本在 fixture 子类）
    const d = new SqliteDriver();
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

/** 测试用：每次拿全新的 fixture（不经注册表）。 */
export function freshDriver(): SourceDriver {
  return SqliteFixtureDriver.seeded();
}

/** 保存连接：先注册再测，通过才落库。失败还回旧驱动。test=true 时空库不落库。 */
export async function saveConnection(ws: string, rec: ConnectionRec, test?: boolean): Promise<{ ok: true; saved: boolean; warning?: string; tables?: TableInfo[] }> {
  const next = { ...rec };
  if (next.type === "sqlite") {
    if (!next.db_name) throw new ConnectionReject("sqlite 连接必须给文件路径（db_name）", "bad_request");
    // turbopackIgnore：路径来自请求，不能静态分析；cwd 只从运行态读，测试换 tmp 才隔得开
    const p = resolve(/* turbopackIgnore: true */ runtime().cwd, next.db_name);
    if (!existsSync(p)) throw new ConnectionReject(`sqlite 文件不存在：${p}`, "bad_request");
    next.db_name = p;
  } else if (!next.host || !next.db_name) {
    throw new ConnectionReject("mysql/pg 连接必须给 host 与 db_name", "bad_request");
  }
  const registry = await getDriverRegistry(ws);
  const previous = (await metaStore().listConnections(ws)).find((c) => c.name === next.name);
  if (!previous && registry.has(next.name)) {
    throw new ConnectionReject(`${next.name} 是内置演示源，换个名字`);
  }
  registerSaved(registry, next);
  if (test) {
    try {
      const tables = await registry.introspect(next.name);
      if (tables.length === 0) {
        registry.unregister(next.name);
        if (previous) registerSaved(registry, previous);
        return { ok: true, warning: "连上了，但库里没有表", tables, saved: false };
      }
    } catch (e) {
      registry.unregister(next.name);
      if (previous) registerSaved(registry, previous);
      throw new ConnectionReject(`连不上：${e instanceof Error ? e.message : String(e)}`);
    }
  }
  await metaStore().saveConnection(ws, next);
  return { ok: true, saved: true };
}

/** 删除已保存的连接。内置演示源不在元库，删不了；已发布本体还引用着的也不能删。 */
export async function dropConnection(ws: string, name: string): Promise<void> {
  if (!(await metaStore().listConnections(ws)).some((c) => c.name === name)) {
    throw new ConnectionReject(`连接不存在：${name}（内置演示源不能删）`);
  }
  const inUse = Object.values((await getPublished(ws)).config.object_types).some((t) =>
    Object.values(t.sources ?? {}).some((s) => s.connection === name)
  );
  if (inUse) throw new ConnectionReject(`连接 ${name} 仍被已发布本体引用，先改本体再删`);
  await metaStore().deleteConnection(ws, name);
  (await getDriverRegistry(ws)).unregister(name);
}
