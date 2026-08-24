// 个体 —— 同一性标准对齐之后，一个体 = 各源各一行（或缺行）。
// 本模块只管核心类型（Cls/Individual/Env）与源列取值原语（mustCls/mustLink/propValue/keyColumn）。
// 行级比较在 compare.ts；when/派生/过滤核对在 evaluate.ts；下推组装与 createEnv 在 assemble.ts。
// 问数只投影结果树；动作经这些模块读个体。

import type { LinkType, ObjectType, OntologyConfig } from "../../schema/config";
import { resolveLink } from "../../schema/spec/filterSpec";
import type { SourceDriver } from "../infra/driver";
import { EngineReject } from "../../errors";
import type { EvalContext } from "./expr";

/** 类名 + 类定义，成对传。 */
export interface Cls {
  name: string;
  def: ObjectType;
}

export interface Individual {
  key: string; // 对齐键的值（identity 或源条目 key 的原值，转字符串做键）
  rows: Record<string, Record<string, unknown> | null>; // 源条目名 → 行（列→值）；null = 该源无行
}

export interface Env {
  config: OntologyConfig;
  driver: SourceDriver;
  // 关系是否成立、某类有没有这个体——createEnv（assemble.ts）提供。异步：要查源
  linkHolds(clsName: string, ind: Individual, linkName: string, target: unknown, ctx: EvalContext): Promise<boolean>;
  existsIndividual(clsName: string, identityValue: unknown): Promise<boolean>;
}

/** 关系名对不上配置即拒绝（问数展开、个体组装、Env.linkHolds 共用）。 */
export function mustLink(config: OntologyConfig, clsName: string, name: string): { link: LinkType; reversed: boolean } {
  const found = resolveLink(config, clsName, name);
  if (!found) throw new EngineReject(`关系名对不上配置：${clsName} 出发没有 ${name}`);
  return found;
}

export function mustCls(config: OntologyConfig, name: string): Cls {
  const def = config.object_types[name];
  if (!def) throw new EngineReject(`配置中没有类：${name}`);
  return { name, def };
}

export function sourcesOf(cls: Cls): [string, NonNullable<ObjectType["sources"]>[string]][] {
  return Object.entries(cls.def.sources ?? {});
}

/** 该源用来对齐、认行的列：源条目的 key，省略则用类的 identity。 */
export function keyColumn(cls: Cls, entry: { fields: Record<string, string>; key?: string }): string {
  const keyProp = entry.key ?? cls.def.identity;
  if (!keyProp) throw new EngineReject("类没有 identity，源条目也没有 key");
  const col = entry.fields[keyProp];
  if (!col) throw new EngineReject(`源条目的 fields 里没有对齐属性 ${keyProp}`);
  return col;
}

/** 源列属性的值：按 sources 声明顺序，排在前面的源优先；该源无行则看下一个。 */
export function propValue(cls: Cls, ind: Individual, prop: string): unknown {
  const def = cls.def.properties[prop];
  if (!def) throw new EngineReject(`类上没有属性：${prop}`); // 点错名是配置/请求问题（422），不是系统故障
  for (const [src, entry] of sourcesOf(cls)) {
    const col = entry.fields[prop];
    const row = ind.rows[src];
    if (col && row) return row[col] ?? null;
  }
  return undefined;
}

/** 指定源条目上某属性的值（when 过滤、写回认值用）。 */
export function propValueFrom(cls: Cls, ind: Individual, src: string, prop: string): unknown {
  const entry = cls.def.sources?.[src];
  const row = ind.rows[src];
  if (!entry || !row) return undefined;
  const col = entry.fields[prop];
  return col ? (row[col] ?? null) : undefined;
}

/** 个体的源列属性视图（{ property, from: current } 的默认来源；不碰派生，避免递归）。 */
export function currentView(cls: Cls, ind: Individual): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [prop, def] of Object.entries(cls.def.properties)) {
    if (!def.derived) out[prop] = propValue(cls, ind, prop);
  }
  return out;
}
