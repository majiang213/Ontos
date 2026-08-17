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
    validateSemantics(cachedConfig); // 语义不合法也抛：identity 缺映射、派生属性进 fields、关系端点不存在等
  }
  return cachedConfig;
}

/** 附录 B 里 zod 管不着的语义约束，加载时一次校验。 */
export function validateSemantics(config: OntologyConfig): void {
  for (const [clsName, cls] of Object.entries(config.object_types)) {
    if (cls.identity && !cls.properties[cls.identity]) {
      throw new Error(`配置不合法：${clsName} 的 identity 指向不存在的属性 ${cls.identity}`);
    }
    const derivedProps = new Set(Object.entries(cls.properties).filter(([, d]) => d.derived).map(([p]) => p));
    for (const [srcName, entry] of Object.entries(cls.sources ?? {})) {
      const keyProp = entry.key ?? cls.identity;
      if (keyProp && !entry.fields[keyProp]) {
        throw new Error(`配置不合法：${clsName}.${srcName} 的 fields 缺对齐属性 ${keyProp}`);
      }
      for (const prop of Object.keys(entry.fields)) {
        if (derivedProps.has(prop)) throw new Error(`配置不合法：派生属性不得进 fields（${clsName}.${srcName} 的 ${prop}）`);
        if (!cls.properties[prop]) throw new Error(`配置不合法：${clsName}.${srcName} 的 fields 指向不存在的属性 ${prop}`);
      }
    }
  }
  for (const [linkName, link] of Object.entries(config.link_types)) {
    for (const end of [link.from, link.to]) {
      if (!config.object_types[end]) throw new Error(`配置不合法：关系 ${linkName} 的端点 ${end} 不存在`);
    }
    if (link.match) {
      for (const pair of link.match) {
        if (!config.object_types[link.from].properties[pair.from]) {
          throw new Error(`配置不合法：关系 ${linkName} 的 match 指向不存在的属性 ${link.from}.${pair.from}`);
        }
        if (!config.object_types[link.to].properties[pair.to]) {
          throw new Error(`配置不合法：关系 ${linkName} 的 match 指向不存在的属性 ${link.to}.${pair.to}`);
        }
      }
    }
    if (link.transition) {
      const def = config.object_types[link.from].properties[link.transition.property];
      if (!def?.derived || !Array.isArray(def.derived)) {
        throw new Error(`配置不合法：关系 ${linkName} 的 transition.property 不是 when 派生（${link.from}.${link.transition.property}）`);
      }
    }
  }
  for (const [clsName, cls] of Object.entries(config.object_types)) {
    for (const [actName, act] of Object.entries(cls.actions ?? {})) {
      for (const inf of act.inform ?? []) {
        if (!config.object_types[inf.object]) throw new Error(`配置不合法：${clsName}.${actName} 的 inform 对象 ${inf.object} 不存在`);
        for (const outlet of inf.to) {
          if (!config.outlets?.[outlet]) throw new Error(`配置不合法：${clsName}.${actName} 的 inform 指向未声明的出站 ${outlet}`);
        }
      }
    }
  }
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
