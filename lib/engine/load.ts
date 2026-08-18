// 已发布配置的加载与驱动注册表 —— 引擎只读已发布版本（种子文件或 versions/ 里最新的 vN）。
// 单例挂 globalThis：Next dev 下各路由包各有模块实例，挂全局才能保证
// 「验收之后再问，看到的是同一个源库」「发布之后引擎立刻读新版」。

import type { OntologyConfig } from "../schema/config";
import type { SourceDriver } from "./driver";
import { SqliteFixtureDriver } from "./fixture";
import { DriverRegistry } from "./registry";
import { makeSqlDriver } from "./sqlDriver";
import { getPublished } from "./configStore";
import { metaStore } from "../meta/store";

const g = globalThis as unknown as { __ontosRegistry?: DriverRegistry };

export function loadConfig(): OntologyConfig {
  return getPublished().config; // 已发布快照；工作副本的读写走 configStore
}

/** 演示用驱动注册表：fixture 四个连接 + 元数据库里保存的连接（mysql/pg/sqlite 文件）。 */
export function demoDriver(): DriverRegistry {
  if (!g.__ontosRegistry) {
    const registry = new DriverRegistry();
    const fixture = SqliteFixtureDriver.seeded();
    for (const conn of fixture.connections()) registry.register(conn, fixture);
    for (const rec of metaStore().listConnections()) registerSaved(registry, rec);
    g.__ontosRegistry = registry;
  }
  return g.__ontosRegistry;
}

/** 把元数据库里的连接注册成驱动。新保存的连接在运行时也走这里（即时生效）。 */
export function registerSaved(registry: DriverRegistry, rec: { name: string; type: string; host?: string; port?: number; db_name?: string; ro_user?: string; ro_pass?: string; rw_user?: string; rw_pass?: string }): void {
  if (rec.type === "sqlite") {
    // SQLite 文件库：db_name 是文件路径
    const d = new SqliteFixtureDriver();
    d.registerFile(rec.name, rec.db_name ?? ":memory:");
    registry.register(rec.name, d);
  } else {
    registry.register(rec.name, makeSqlDriver({ type: rec.type, host: rec.host, port: rec.port, db_name: rec.db_name, ro_user: rec.ro_user, ro_pass: rec.ro_pass, rw_user: rec.rw_user, rw_pass: rec.rw_pass }));
  }
}

/** 测试用：每次拿全新的 fixture（不经注册表）。 */
export function freshDriver(): SourceDriver {
  return SqliteFixtureDriver.seeded();
}

/** 测试用：关掉并清掉注册表单例。fixture 内存库全进程共享，换测试目录前必须清。 */
export function resetRegistry(): void {
  const r = g.__ontosRegistry;
  if (r) for (const name of r.connectionNames()) r.unregister(name);
  g.__ontosRegistry = undefined;
}
