// 已发布配置的加载 —— 引擎只读这份文本（M4 版本化之前，先读种子文件）。

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "js-yaml";
import { configSchema, type OntologyConfig } from "../schema/config";
import type { SourceDriver } from "./driver";
import { SqliteFixtureDriver } from "./fixture";

let cachedConfig: OntologyConfig | null = null;

export function loadConfig(): OntologyConfig {
  if (!cachedConfig) {
    const text = readFileSync(join(process.cwd(), "lib/config/ontology.yaml"), "utf8");
    cachedConfig = configSchema.parse(load(text)); // 结构不合法直接抛，引擎不猜
  }
  return cachedConfig;
}

let cachedDriver: SourceDriver | null = null;

/** 演示用驱动：SQLite fixture（没有 MySQL/PG 时的离线源库）。 */
export function demoDriver(): SourceDriver {
  if (!cachedDriver) cachedDriver = SqliteFixtureDriver.seeded();
  return cachedDriver;
}

/** 测试用：每次拿全新的。 */
export function freshDriver(): SourceDriver {
  return SqliteFixtureDriver.seeded();
}
