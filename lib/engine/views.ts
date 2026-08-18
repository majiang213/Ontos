// 配置三视图 —— Agent 编请求前按需读取，不读整份配置（《ontos-article.md》§5.3）。
// 列出类 / 读取一个类 / 检索。description 供阅读；填进 JSON 的是 name。

import type { OntologyConfig } from "../schema/config";
import { EngineReject } from "./individual";

export interface ClassListItem {
  name: string;
  description?: string;
}

/** 视图一：列出类。不含属性、关系、源映射。 */
export function listClasses(config: OntologyConfig): ClassListItem[] {
  return Object.entries(config.object_types).map(([name, t]) => ({ name, description: t.description }));
}

export interface ClassView {
  name: string;
  description?: string;
  kind: string;
  identity?: string;
  properties: {
    name: string;
    type: string;
    description?: string;
    values?: (string | number)[]; // 枚举附 values
    derived?: "when" | "filter"; // 派生附形式
  }[];
  relations: { name: string; description?: string; to: string }[]; // 从该类出发的（含反向名）
  actions: { name: string; description?: string; pre?: unknown }[];
  // 不返回：sources、pk、axioms
}

/** 视图二：读取一个类。 */
export function readClass(config: OntologyConfig, name: string): ClassView {
  const t = config.object_types[name];
  if (!t) throw new EngineReject(`配置中没有类：${name}`);
  const relations: ClassView["relations"] = [];
  for (const [linkName, l] of Object.entries(config.link_types)) {
    if (l.from === name) relations.push({ name: linkName, description: l.description, to: l.to });
    if (l.to === name && l.inverse) relations.push({ name: l.inverse, description: `${l.description ?? linkName}（反向）`, to: l.from });
  }
  return {
    name,
    description: t.description,
    kind: t.kind,
    identity: t.identity,
    properties: Object.entries(t.properties).map(([p, d]) => ({
      name: p,
      type: d.type,
      description: d.description,
      values: d.values,
      derived: d.derived ? (Array.isArray(d.derived) ? "when" : "filter") : undefined,
    })),
    relations,
    actions: Object.entries(t.actions ?? {}).map(([a, d]) => ({ name: a, description: d.description, pre: d.pre })),
  };
}

/** 视图三：检索。类很多时按名字与说明的相关度返回类名、关系名。 */
export function search(config: OntologyConfig, text: string): { classes: string[]; relations: string[] } {
  const q = text.trim();
  const hit = (s?: string) => Boolean(q && s && s.includes(q));
  return {
    classes: Object.entries(config.object_types)
      .filter(([name, t]) => hit(name) || hit(t.description))
      .map(([name]) => name),
    relations: Object.entries(config.link_types)
      .filter(([name, l]) => hit(name) || hit(l.description) || hit(l.inverse))
      .map(([name]) => name),
  };
}
