// 配置三视图 —— Agent 编请求前按需读取，不读整份配置（《ontos-article.md》§5.3）。
// 列出类 / 读取一个类 / 检索。description 供阅读；填进 JSON 的是 name。
// 已发布视图不返回 sources/pk（问数 Agent 不绑表）；草稿视图（space=draft）带状态与来源对照，供改画布。

import type { ActionDef, OntologyConfig } from "../../schema/config";
import { replaceBlockers } from "./ops/replaceObject";
import { sameConfig } from "./sameConfig";
import { EngineReject, MSG } from "../../errors";

/** 类相对已发布快照的状态（与 GET /api/ontology 的 states 同一算法）。 */
export type ClassState = "new" | "modified" | "same";

/** 草稿/已发布对照算状态：已发布没有 → new；结构不同 → modified；否则 same。 */
export function classState(draft: OntologyConfig, published: OntologyConfig, name: string): ClassState {
  const pub = published.object_types[name];
  const t = draft.object_types[name];
  if (!t) throw new EngineReject(MSG.classNotInConfig(name));
  return !pub ? "new" : sameConfig(pub, t) ? "same" : "modified";
}

/** 草稿 vs 已发布的结构 diff：states（逐类）、deleted（待删除名单）、action_changes（类名.动作名 三向差集）。
 *  GET /api/ontology 与画布监视器共用这一份，不再在路由里内联。 */
export interface DraftDiff {
  states: Record<string, ClassState>;
  deleted: string[];
  action_changes: { added: string[]; overwritten: string[]; removed: string[] };
}

export function draftDiff(draft: OntologyConfig, published: OntologyConfig): DraftDiff {
  const states: Record<string, ClassState> = {};
  for (const name of Object.keys(draft.object_types)) states[name] = classState(draft, published, name);
  const deleted = Object.keys(published.object_types).filter((name) => !(name in draft.object_types));
  const action_changes: DraftDiff["action_changes"] = { added: [], overwritten: [], removed: [] };
  for (const cls of new Set([...Object.keys(draft.object_types), ...Object.keys(published.object_types)])) {
    const da = draft.object_types[cls]?.actions ?? {};
    const pa = published.object_types[cls]?.actions ?? {};
    for (const n of Object.keys(da)) {
      if (!(n in pa)) action_changes.added.push(`${cls}.${n}`);
      else if (!sameConfig(da[n], pa[n])) action_changes.overwritten.push(`${cls}.${n}`);
    }
    for (const n of Object.keys(pa)) if (!(n in da)) action_changes.removed.push(`${cls}.${n}`);
  }
  return { states, deleted, action_changes };
}

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
  relations: { name: string; description?: string; to: string; kind: "match" | "transition" }[]; // 从该类出发的（含反向名）；kind 区分普通配对与转化
  actions: { name: string; description?: string; pre?: unknown }[];
  // 不返回：sources、pk、axioms
}

/** 视图二：读取一个类。 */
export function readClass(config: OntologyConfig, name: string): ClassView {
  const t = config.object_types[name];
  if (!t) throw new EngineReject(MSG.classNotInConfig(name));
  const relations: ClassView["relations"] = [];
  for (const [linkName, l] of Object.entries(config.link_types)) {
    const kind = l.transition ? ("transition" as const) : ("match" as const);
    if (l.from === name) relations.push({ name: linkName, description: l.description, to: l.to, kind });
    if (l.to === name && l.inverse) relations.push({ name: l.inverse, description: `${l.description ?? linkName}（反向）`, to: l.from, kind });
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

/* ---------- 草稿视图（space=draft）：给改画布的 Agent 看，带状态与来源对照 ---------- */

export interface DraftClassListItem extends ClassListItem {
  state: ClassState;
  /** 已定的唯一键字段名；还没定就不写这个键。 */
  identity?: string;
}

/** 草稿版「列出类」：每个类带相对已发布的状态、已定的唯一键。 */
export function listClassesDraft(draft: OntologyConfig, published: OntologyConfig): DraftClassListItem[] {
  return Object.entries(draft.object_types).map(([name, t]) => ({
    name,
    description: t.description,
    state: classState(draft, published, name),
    ...(t.identity ? { identity: t.identity } : {}),
  }));
}

/** 草稿版「列出类」的整包（MCP list_classes space=draft 的 payload 形状单源）：
 *  classes 带状态；outlets 是全局出站名（inform 的合法去向），只读——没有写入 op。
 *  纯函数：取数（getDraft/published/getRev）在调用方。 */
export interface DraftClassesPayload {
  space: "draft";
  dirty: boolean;
  rev: number;
  base_version: number;
  classes: DraftClassListItem[];
  outlets: string[];
}

export function draftClassesPayload(state: { draft: OntologyConfig; dirty: boolean; baseVersion: number }, published: OntologyConfig, rev: number): DraftClassesPayload {
  return {
    space: "draft",
    dirty: state.dirty,
    rev,
    base_version: state.baseVersion,
    classes: listClassesDraft(state.draft, published),
    outlets: Object.keys(state.draft.outlets ?? {}),
  };
}

export interface DraftClassView extends Omit<ClassView, "actions"> {
  state: ClassState;
  /** 来源对照（连接名/表名/主键/字段映射）：逐步改画布必须看见；不含连接密码。 */
  sources: { name: string; connection: string; table: string; pk?: string; fields: Record<string, string> }[];
  /** 能不能整份替换（replace_object）；replace_blockers 为空数组 = 可替换。与 replace_object 共用 replaceBlockers（同文件 ops/replaceObject）。 */
  replaceable: boolean;
  replace_blockers: string[];
  /** 草稿视图给完整动作定义（effect/inform 原样，不压扁）——动作的读回-改-写回闭环靠它。 */
  actions: { name: string; def: ActionDef }[];
}

/** 草稿版「读取一个类」：在 ClassView 上补状态、来源对照、整份替换锁定与完整动作定义。 */
export function readClassDraft(draft: OntologyConfig, published: OntologyConfig, name: string): DraftClassView {
  const base = readClass(draft, name);
  const t = draft.object_types[name]; // readClass 已保证存在
  const blockers = replaceBlockers(t, Boolean(published.object_types[name]));
  return {
    ...base,
    state: classState(draft, published, name),
    sources: Object.entries(t.sources ?? {}).map(([srcName, s]) => ({ name: srcName, connection: s.connection, table: s.table, pk: s.pk, fields: s.fields })),
    replaceable: blockers.length === 0,
    replace_blockers: blockers,
    actions: Object.entries(t.actions ?? {}).map(([a, def]) => ({ name: a, def })),
  };
}
