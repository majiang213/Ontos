// 已发布配置的加载 —— 引擎只读已发布版本（种子文件或 versions/ 里最新的 vN）。
// 单例挂 globalThis：Next dev 下各路由包各有模块实例，挂全局才能保证
// 「验收之后再问，看到的是同一个源库」「发布之后引擎立刻读新版」。

import type { OntologyConfig } from "../schema/config";
import type { SourceDriver } from "./driver";
import { SqliteFixtureDriver } from "./fixture";
import { getPublished } from "./configStore";

const g = globalThis as unknown as { __ontosDriver?: SourceDriver };

export function loadConfig(): OntologyConfig {
  return getPublished().config; // 已发布快照；工作副本的读写走 configStore
}

/** 演示用驱动：SQLite fixture（没有 MySQL/PG 时的离线源库）。 */
export function demoDriver(): SourceDriver {
  if (!g.__ontosDriver) g.__ontosDriver = SqliteFixtureDriver.seeded();
  return g.__ontosDriver;
}

/** 测试用：每次拿全新的。 */
export function freshDriver(): SourceDriver {
  return SqliteFixtureDriver.seeded();
}
