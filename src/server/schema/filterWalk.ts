// 过滤树走查器 —— 配置语法里 $link 过滤树的唯一遍历入口（附录 B 的核心形状）。
// 校验（validate）、值形状核对（individual）、引用扫描（configStore）、下推（query）都消费它。
// 新增保留字只改这里；关系解析也随之收在本文件（schema 层，引擎各文件不再各自心算）。

import type { Filter, LinkType, OntologyConfig } from "./config";

/** 关系解析（唯一出处）：正向名在 from 侧（目标 to），反向名（inverse）在 to 侧（目标 from）。找不到返回 undefined。 */
export function resolveLink(config: OntologyConfig, clsName: string, name: string): { link: LinkType; reversed: boolean } | undefined {
  const direct = config.link_types[name];
  if (direct && direct.from === clsName) return { link: direct, reversed: false };
  for (const link of Object.values(config.link_types)) {
    if (link.inverse === name && link.to === clsName) return { link, reversed: true };
  }
  return undefined;
}

/** 关系名 → 目标类；未解析返回 null（报不报错由调用方定）。 */
export function linkTarget(config: OntologyConfig, clsName: string, name: string): string | null {
  const r = resolveLink(config, clsName, name);
  return r ? (r.reversed ? r.link.from : r.link.to) : null;
}

export type FilterVisit = {
  /** 属性条件键。cls 是该键所属的类（$link 嵌套里是目标类）。 */
  prop?: (cls: string, key: string, value: unknown, depth: number) => void;
  /** $link 条目：target 已解析（未解析为 null）。返回 false 不递归进子过滤（默认递归）。 */
  link?: (cls: string, name: string, target: string | null, sub: unknown, depth: number) => false | void;
  /** $request / $exists 等 $ 键（内容不递归）。 */
  special?: (cls: string, key: string, value: unknown) => void;
};

/**
 * 递归走查一棵过滤树。config 给 null 时只做结构遍历（target 一律 null），供不关心关系解析的消费方。
 * $link 的子过滤按目标类递归；子值是 true/false（存在性写法）只发事件不递归。
 */
export function walkFilter(config: OntologyConfig | null, clsName: string, filter: Filter, visit: FilterVisit, depth = 0): void {
  for (const [k, v] of Object.entries(filter)) {
    if (k === "$link") {
      for (const [ln, sub] of Object.entries(v as Filter)) {
        const target = config ? linkTarget(config, clsName, ln) : null;
        const recurse = visit.link?.(clsName, ln, target, sub, depth);
        if (recurse !== false && sub !== null && typeof sub === "object" && !Array.isArray(sub)) {
          walkFilter(config, target ?? clsName, sub as Filter, visit, depth + 1);
        }
      }
      continue;
    }
    if (k.startsWith("$")) {
      visit.special?.(clsName, k, v);
      continue;
    }
    visit.prop?.(clsName, k, v, depth);
  }
}
