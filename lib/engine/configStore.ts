// 配置存储 —— M4 雏形。工作副本（草稿）与已发布版本的唯一出入口。
// 画布读写副本；引擎只读已发布。已发布配置与版本链存共享元库（onto_version，按 workspace_id 隔离）；
// 发布 = 校验 + 插入新版行（git revert 语义，历史链不断）。摆位存 onto_workspace.layout。

import { dump, load } from "js-yaml";
import { configSchema, objectTypeSchema, type OntologyConfig } from "../schema/config";
import type { DraftOpInput as DraftOp } from "../schema/ops";
import { metaStore } from "../meta/store";
import { findLink } from "./individual";
import { validateSemantics } from "./validate";
import { DEFAULT_WS, seedYamlFor } from "./workspace";

/* ---------- 已发布 ---------- */

export interface DraftState {
  draft: OntologyConfig;
  baseVersion: number; // 基于哪个已发布版本
  dirty: boolean; // 与已发布是否有差异（按结构比较，每次操作后重算）
  layout: Record<string, { x: number; y: number }>; // 画布摆位（存 onto_workspace.layout）
}

interface Store {
  published?: { config: OntologyConfig; version: number };
  draft?: DraftState;
}
// 每个工作空间一份内存态（已发布快照 + 工作副本），互不串
const g = globalThis as unknown as { __ontosStores?: Map<string, Store> };
const stores: Map<string, Store> = g.__ontosStores ?? (g.__ontosStores = new Map());
function storeOf(ws: string): Store {
  let s = stores.get(ws);
  if (!s) {
    s = {};
    stores.set(ws, s);
  }
  return s;
}

async function loadPublished(ws: string): Promise<{ config: OntologyConfig; version: number }> {
  const { version, yaml } = await metaStore().latestVersion(ws, seedYamlFor(ws));
  const config = configSchema.parse(load(yaml));
  validateSemantics(config);
  return { config, version };
}

export async function getPublished(ws: string = DEFAULT_WS): Promise<{ config: OntologyConfig; version: number }> {
  const store = storeOf(ws);
  if (!store.published) store.published = await loadPublished(ws);
  return store.published;
}

export async function getDraft(ws: string = DEFAULT_WS): Promise<DraftState> {
  const store = storeOf(ws);
  if (!store.draft) {
    const { config, version } = await getPublished(ws);
    const layout = await metaStore().getLayout(ws);
    store.draft = { draft: structuredClone(config), baseVersion: version, dirty: false, layout };
  }
  return store.draft;
}

/* ---------- 编辑操作（作用于工作副本） ---------- */

export class DraftReject extends Error {} // 操作不合法：名字重了、对象不存在等

export async function applyOp(input: DraftOp, ws: string = DEFAULT_WS): Promise<DraftState> {
  const state = await getDraft(ws);
  const backup = structuredClone(state.draft);
  const d = state.draft;
  switch (input.op) {
    case "create_object": {
      if (!/^[a-z][a-z0-9_]*$/.test(input.name)) throw new DraftReject("类名必须是小写字母/数字/下划线，字母开头");
      if (d.object_types[input.name]) throw new DraftReject(`类已存在：${input.name}`);
      d.object_types[input.name] = { kind: input.kind, description: input.description, properties: {} }; // 无源对象进 manual 桶
      break;
    }
    case "delete_object": {
      if (!d.object_types[input.name]) throw new DraftReject(`类不存在：${input.name}`);
      dropClass(d, input.name);
      break;
    }
    case "update_object": {
      const t = mustType(d, input.name);
      if (input.description !== undefined) t.description = input.description;
      break;
    }
    case "add_property": {
      const t = mustType(d, input.object);
      if (!/^[a-z][a-z0-9_]*$/.test(input.name)) throw new DraftReject("属性名必须是小写字母/数字/下划线，字母开头");
      if (t.properties[input.name]) throw new DraftReject(`属性已存在：${input.name}`);
      t.properties[input.name] = { type: input.type, description: input.description, values: input.values };
      break;
    }
    case "remove_property": {
      const t = mustType(d, input.object);
      if (!t.properties[input.name]) throw new DraftReject(`属性不存在：${input.name}`);
      if (t.identity === input.name) throw new DraftReject("识别字段不能直接删，先换识别字段");
      const refs = referencesOf(d, input.object, input.name);
      if (refs.length) throw new DraftReject(`${input.name} 仍被引用：${refs.join("、")}`);
      delete t.properties[input.name];
      break;
    }
    case "set_identity": {
      const t = mustType(d, input.object);
      if (input.name === "") {
        delete t.identity; // 取消识别字段
        break;
      }
      if (!t.properties[input.name]) throw new DraftReject(`属性不存在：${input.name}`);
      if (t.properties[input.name].derived) throw new DraftReject("派生属性不能当识别字段");
      t.identity = input.name;
      break;
    }
    case "save_layout": {
      state.layout = { ...state.layout, ...input.positions };
      await metaStore().setLayout(ws, state.layout); // 摆位入库（onto_workspace.layout），重启不丢
      return state; // 摆位不算本体改动，不碰 dirty
    }
    case "create_link": {
      if (!/^[a-z][a-z0-9_]*$/.test(input.name)) throw new DraftReject("关系名必须是小写字母/数字/下划线，字母开头");
      if (d.link_types[input.name]) throw new DraftReject(`关系已存在：${input.name}`);
      mustType(d, input.from);
      mustType(d, input.to);
      if (!d.object_types[input.from].properties[input.match.from]) throw new DraftReject(`${input.from} 上没有属性 ${input.match.from}`);
      if (!d.object_types[input.to].properties[input.match.to]) throw new DraftReject(`${input.to} 上没有属性 ${input.match.to}`);
      if (input.inverse && !/^[a-z][a-z0-9_]*$/.test(input.inverse)) throw new DraftReject("反向名必须是小写字母/数字/下划线，字母开头");
      d.link_types[input.name] = {
        from: input.from,
        to: input.to,
        inverse: input.inverse || undefined,
        card: input.card,
        description: input.description,
        match: [{ from: input.match.from, to: input.match.to }], // 手动关系只说配对字段；转化关系由裁决产生
      };
      break;
    }
    case "delete_link": {
      if (!d.link_types[input.name]) throw new DraftReject(`关系不存在：${input.name}`);
      const refs = linkRefs(d, input.name);
      if (refs.length) throw new DraftReject(`${input.name} 仍被引用：${refs.join("、")}`);
      delete d.link_types[input.name];
      break;
    }
    case "import_objects": {
      // 先全量预检再一次落草稿：循环里半途抛错不会留下前几个类（孤儿对象会随下次发布混出去）
      const staged: [string, OntologyConfig["object_types"][string]][] = [];
      for (const [name, raw] of Object.entries(input.objects)) {
        if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new DraftReject(`类名必须是小写字母/数字/下划线，字母开头：${name}`);
        if (d.object_types[name]) throw new DraftReject(`类已存在：${name}`);
        staged.push([name, objectTypeSchema.parse(raw)]); // 逐类过结构校验
      }
      for (const [name, obj] of staged) d.object_types[name] = obj;
      break;
    }
    default:
      throw new DraftReject(`未知操作：${JSON.stringify(input)}`);
  }
  // 每步操作后立即语义校验，不合法整体回退——坏草稿（如 fields 指向不存在属性的导入）不能攒到发布一刻才炸
  try {
    validateSemantics(configSchema.parse(structuredClone(state.draft)));
  } catch (e) {
    state.draft = backup;
    throw new DraftReject(e instanceof Error ? e.message : String(e));
  }
  // 校验过了再动摆位：被删对象的摆位随内容一起清（校验失败回退时摆位不丢）
  if (input.op === "delete_object" && state.layout[input.name]) {
    delete state.layout[input.name];
    await metaStore().setLayout(ws, state.layout);
  }
  // 每次操作后按结构重算：改出去又改回来，dirty 要能收回来
  state.dirty = !sameConfig(state.draft, (await getPublished(ws)).config);
  return state;
}

function mustType(d: OntologyConfig, name: string) {
  const t = d.object_types[name];
  if (!t) throw new DraftReject(`类不存在：${name}`);
  return t;
}

/** 撤一个类，连同挂着它的关系（delete_object 与裁决的 mergeInto 共用）。 */
export function dropClass(d: OntologyConfig, name: string): void {
  delete d.object_types[name];
  for (const [linkName, link] of Object.entries(d.link_types)) {
    if (link.from === name || link.to === name) delete d.link_types[linkName];
  }
}

/** 删除属性前的引用扫描：源映射、关系配对、转化、公理、同类派生规则、动作（含跨类）。 */
function referencesOf(d: OntologyConfig, clsName: string, prop: string): string[] {
  const refs: string[] = [];
  const cls = d.object_types[clsName];
  for (const [src, e] of Object.entries(cls.sources ?? {})) if (e.fields[prop]) refs.push(`源映射 ${src}`);
  for (const [name, ax] of Object.entries(cls.axioms ?? {})) if (ax.property === prop) refs.push(`公理 ${name}`);
  for (const [name, link] of Object.entries(d.link_types)) {
    if (link.from === clsName && link.match?.some((p) => p.from === prop)) refs.push(`关系 ${name}`);
    if (link.to === clsName && link.match?.some((p) => p.to === prop)) refs.push(`关系 ${name}`);
    if (link.from === clsName && link.transition?.property === prop) refs.push(`关系 ${name}`);
  }
  // 同类派生规则的过滤键
  for (const [p, def] of Object.entries(cls.properties)) {
    if (p !== prop && def.derived && derivedFilterKeys(def.derived).includes(prop)) refs.push(`派生属性 ${p}`);
  }
  refs.push(...actionRefs(d, clsName, prop));
  // 他类派生经 $link 落到本类的过滤键（键侧，跨类）
  for (const [hostName, hostCls] of Object.entries(d.object_types)) {
    if (hostName === clsName) continue;
    for (const [p, def] of Object.entries(hostCls.properties)) {
      if (!def.derived) continue;
      const whens = Array.isArray(def.derived) ? def.derived.map((r) => (r as { when?: unknown }).when) : [def.derived];
      const check = (f: unknown, host: string) => {
        if (!f || typeof f !== "object") return;
        for (const [ln, sub] of Object.entries((f as Record<string, unknown>).$link ?? {})) {
          const target = linkTarget(d, host, ln);
          if (target === clsName && sub && typeof sub === "object" && filterTopKeys(sub as Record<string, unknown>).includes(prop)) refs.push(`派生属性 ${hostName}.${p}`);
          if (target) check(sub, target);
        }
      };
      for (const w of whens) check(w, hostName);
    }
  }
  // 值侧引用：过滤/赋值里的 { property: prop }（被比较、被读取的属性也是引用）
  const valueRefs = new Set<string>();
  for (const [hostName, hostCls] of Object.entries(d.object_types)) {
    for (const [p, def] of Object.entries(hostCls.properties)) {
      if (!def.derived || hostName !== clsName) continue;
      const whens = Array.isArray(def.derived) ? def.derived.map((r) => (r as { when?: unknown }).when) : [def.derived];
      for (const w of whens) valuePropRefs(w, hostName, `派生属性 ${hostName}.${p}`, d, clsName, prop, valueRefs);
    }
    for (const [actName, act] of Object.entries(hostCls.actions ?? {})) {
      const trail = `动作 ${hostName}.${actName}`;
      valuePropRefs(act.pre, hostName, trail, d, clsName, prop, valueRefs);
      for (const item of act.effect ?? []) {
        if ("link" in item) continue;
        const op = "update" in item ? item.update : "delete" in item ? item.delete : "create" in item ? item.create : null;
        if (!op) continue;
        if ("filter" in op && op.filter) valuePropRefs(op.filter, op.object, trail, d, clsName, prop, valueRefs);
        if ("properties" in op && op.properties) {
          // update 的 current 是目标类视图；create 的 current 是动作宿主（主体）视图
          const attrCls = "update" in item ? op.object : hostName;
          for (const v of Object.values(op.properties)) valuePropRefs(v, attrCls, trail, d, clsName, prop, valueRefs);
        }
      }
      // inform 的属性表在动作宿主（主体）上取值
      for (const inf of act.inform ?? []) {
        for (const v of Object.values(inf.properties)) valuePropRefs(v, hostName, trail, d, clsName, prop, valueRefs);
      }
    }
  }
  refs.push(...valueRefs);
  return refs;
}

/** 关系的引用扫描：动作 pre 的 $link、effect 的 link 项、effect update/delete 的 filter.$link、派生规则里的 $link。删关系前挡一道。 */
function linkRefs(d: OntologyConfig, linkName: string): string[] {
  const refs = new Set<string>();
  const walkFilter = (f: Record<string, unknown> | undefined, trail: string) => {
    if (!f || typeof f !== "object") return;
    const linkBlock = f.$link as Record<string, unknown> | undefined;
    for (const [ln, sub] of Object.entries(linkBlock ?? {})) {
      if (ln === linkName) refs.add(trail);
      if (sub && typeof sub === "object") walkFilter(sub as Record<string, unknown>, trail);
    }
  };
  for (const [clsName, cls] of Object.entries(d.object_types)) {
    for (const [actName, act] of Object.entries(cls.actions ?? {})) {
      const trail = `动作 ${clsName}.${actName}`;
      walkFilter(act.pre as Record<string, unknown> | undefined, trail);
      for (const item of act.effect ?? []) {
        if ("link" in item && item.link === linkName) refs.add(trail);
        const op = "update" in item ? item.update : "delete" in item ? item.delete : null;
        if (op && "filter" in op) walkFilter(op.filter as Record<string, unknown> | undefined, trail);
      }
    }
    for (const [p, def] of Object.entries(cls.properties)) {
      if (!def.derived) continue;
      const whens = Array.isArray(def.derived) ? def.derived.map((r) => (r as { when?: Record<string, unknown> }).when) : [def.derived as Record<string, unknown>];
      for (const w of whens) walkFilter(w, `派生属性 ${clsName}.${p}`);
    }
  }
  return [...refs];
}

/** 值侧的 { property: x } 引用（from: request 指的是请求参数，不算）：递归过滤树/赋值表，命中即记账。 */
function valuePropRefs(
  node: unknown,
  hostCls: string,
  trail: string,
  d: OntologyConfig,
  clsName: string,
  prop: string,
  refs: Set<string>
): void {
  if (!node || typeof node !== "object" || Array.isArray(node)) return;
  const rec = node as Record<string, unknown>;
  if (typeof rec.property === "string" && rec.from !== "request" && hostCls === clsName && rec.property === prop) refs.add(trail);
  const linkBlock = rec.$link as Record<string, unknown> | undefined;
  for (const [ln, sub] of Object.entries(linkBlock ?? {})) {
    const target = linkTarget(d, hostCls, ln); // $link 嵌套里被点名的属性是目标类的
    valuePropRefs(sub, target ?? hostCls, trail, d, clsName, prop, refs);
  }
  for (const [k, v] of Object.entries(rec)) {
    if (k === "$link") continue;
    if (k === "$request") continue; // $request 块里的 { property } 指的是请求参数袋，不是类属性
    if (v && typeof v === "object") valuePropRefs(v, hostCls, trail, d, clsName, prop, refs);
  }
}

/** 过滤的顶层属性键（$ 键不进）。 */
function filterTopKeys(f: Record<string, unknown>): string[] {
  return Object.keys(f).filter((k) => !k.startsWith("$"));
}

/** 派生定义里出现的本类属性键（when 过滤 + 布尔过滤）。$link 嵌套里的键是目标类的，不收——跨类引用由 referencesOf 的 linkTarget 走查负责。 */
function derivedFilterKeys(derived: unknown): string[] {
  const keys: string[] = [];
  const walk = (f: Record<string, unknown>) => {
    for (const k of Object.keys(f)) {
      if (!k.startsWith("$")) keys.push(k);
    }
  };
  if (Array.isArray(derived)) {
    for (const rule of derived) {
      for (const cond of Object.values((rule as { when: Record<string, unknown> }).when)) {
        if (cond && typeof cond === "object") walk(cond as Record<string, unknown>);
      }
    }
  } else if (derived && typeof derived === "object") {
    walk(derived as Record<string, unknown>);
  }
  return keys;
}

/** 关系名 → 目标类：走引擎同一份解析（findLink），正向取 to，反向名取 from。 */
function linkTarget(d: OntologyConfig, hostCls: string, linkName: string): string | null {
  const r = findLink(d, hostCls, linkName);
  return r ? (r.reversed ? r.link.from : r.link.to) : null;
}

/** 动作里的引用：本类 pre 的键；任意效应指向本类时的属性键；$link 目标过滤落回本类的键。 */
function actionRefs(d: OntologyConfig, clsName: string, prop: string): string[] {
  const refs = new Set<string>();
  const scanNestedLinks = (f: Record<string, unknown> | undefined, hostCls: string, trail: string) => {
    if (!f) return;
    const linkBlock = f.$link as Record<string, unknown> | undefined;
    for (const [linkName, sub] of Object.entries(linkBlock ?? {})) {
      const target = linkTarget(d, hostCls, linkName);
      if (!target || typeof sub !== "object" || sub === null) continue;
      if (target === clsName && filterTopKeys(sub as Record<string, unknown>).includes(prop)) refs.add(trail);
      scanNestedLinks(sub as Record<string, unknown>, target, trail);
    }
  };
  for (const [hostName, hostCls] of Object.entries(d.object_types)) {
    for (const [actName, act] of Object.entries(hostCls.actions ?? {})) {
      const trail = `动作 ${hostName}.${actName}`;
      if (hostName === clsName && act.pre && filterTopKeys(act.pre).includes(prop)) refs.add(trail);
      scanNestedLinks(act.pre, hostName, trail);
      for (const item of act.effect ?? []) {
        const op = "update" in item ? item.update : "delete" in item ? item.delete : "create" in item ? item.create : null;
        if (!op || op.object !== clsName) continue; // link 没有属性键；他类效应不归这里管
        const keys = [
          ...("properties" in op && op.properties ? Object.keys(op.properties) : []),
          ...("filter" in op && op.filter ? filterTopKeys(op.filter) : []),
        ];
        if (keys.includes(prop)) refs.add(trail);
        if ("filter" in op) scanNestedLinks(op.filter, clsName, trail);
      }
    }
  }
  return [...refs];
}

/** 直接改草稿（裁决应用等成组改动走这里）：改完立即校验，不合法就回退并抛 DraftReject——不让坏草稿攒到发布一刻才炸。 */
/** 直接改草稿（裁决应用等成组改动走这里）：改完立即校验，不合法就回退并抛 DraftReject——不让坏草稿攒到发布一刻才炸。 */
export async function mutateDraft(fn: (draft: OntologyConfig) => void, ws: string = DEFAULT_WS): Promise<DraftState> {
  const state = await getDraft(ws);
  const backup = structuredClone(state.draft);
  try {
    fn(state.draft);
    const parsed = configSchema.parse(structuredClone(state.draft));
    validateSemantics(parsed);
  } catch (e) {
    state.draft = backup; // 回退
    throw new DraftReject(e instanceof Error ? e.message : String(e));
  }
  // 被撤的类顺手清摆位（裁决的 dropClass 不走 delete_object），摆位表不留死键
  let layoutChanged = false;
  for (const name of Object.keys(state.layout)) {
    if (!state.draft.object_types[name]) {
      delete state.layout[name];
      layoutChanged = true;
    }
  }
  if (layoutChanged) await metaStore().setLayout(ws, state.layout);
  state.dirty = !sameConfig(state.draft, (await getPublished(ws)).config);
  return state;
}

/* ---------- 发布与放弃 ---------- */

export async function publishDraft(ws: string = DEFAULT_WS): Promise<{ version: number }> {
  const state = await getDraft(ws);
  if (!state.dirty) return { version: state.baseVersion }; // 无改动不产空版本
  const config = configSchema.parse(structuredClone(state.draft)); // 结构校验
  try {
    validateSemantics(config); // 语义校验
  } catch (e) {
    throw new DraftReject(e instanceof Error ? e.message : String(e)); // 归一到类型，路由不用嗅探文案
  }
  const version = (await metaStore().latestVersion(ws, seedYamlFor(ws))).version + 1; // 版本号以库里的链为准
  await metaStore().insertVersion(ws, version, dump(config, { lineWidth: 120, noRefs: true }), "publish");
  storeOf(ws).published = { config, version }; // 换掉已发布快照：引擎下一次 getPublished 即读新版
  state.baseVersion = version;
  state.dirty = false;
  await fillDecisionVersions(version, ws); // 裁决留痕的生效版本随发布回填
  return { version };
}

export async function discardDraft(ws: string = DEFAULT_WS): Promise<void> {
  storeOf(ws).draft = undefined; // 回到已发布快照；摆位在库里，不随草稿丢
  try {
    await metaStore().abandonPendingDecisions(ws); // 草稿里裁过又没发布的留痕标记「已放弃」，不挂到无关的下一次发布上
  } catch {
    // 留痕是附属，不挡放弃
  }
}

/* ---------- 版本历史与回滚 ---------- */

export function listVersions(ws: string = DEFAULT_WS): Promise<{ version: number; createdAt: string; origin: string }[]> {
  return metaStore().listVersions(ws);
}

/** 回滚 = Git revert 语义：把旧版本内容作为新版本插入，历史链不断。草稿有未发布改动时拒绝，先发布或放弃。 */
export async function rollbackTo(version: number, ws: string = DEFAULT_WS): Promise<{ version: number }> {
  if ((await getDraft(ws)).dirty) throw new DraftReject("有未发布的改动，先发布或放弃再回滚");
  const yaml = await metaStore().versionYaml(ws, version);
  if (yaml === undefined) throw new DraftReject(`版本不存在：v${version}`);
  let config: OntologyConfig;
  try {
    config = configSchema.parse(load(yaml));
    validateSemantics(config);
  } catch (e) {
    throw new DraftReject(`配置不合法：v${version} 的内容读不回来（${e instanceof Error ? e.message : String(e)}）`); // 归一前缀，路由按 422 分层
  }
  const newVersion = (await metaStore().latestVersion(ws, seedYamlFor(ws))).version + 1;
  await metaStore().insertVersion(ws, newVersion, dump(config, { lineWidth: 120, noRefs: true }), "rollback", version);
  storeOf(ws).published = { config, version: newVersion };
  storeOf(ws).draft = { draft: structuredClone(config), baseVersion: newVersion, dirty: false, layout: await metaStore().getLayout(ws) };
  await fillDecisionVersions(newVersion, ws); // 回滚也是一次发布：未绑版本的裁决挂到它
  return { version: newVersion };
}

/** 测试用：清空内存态。不传 ws 清全部空间。 */
export function resetStore(ws?: string): void {
  if (ws) stores.delete(ws);
  else stores.clear();
}

/** 发布成功后回填：把还没绑版本的裁决留痕挂上这个版本。回填失败不影响发布。 */
async function fillDecisionVersions(version: number, ws: string): Promise<void> {
  try {
    await metaStore().backfillDecisionVersions(ws, version);
  } catch {
    // 留痕是附属，不挡发布
  }
}

/** 键序无关的结构比较：zod parse 会按 schema 重排键，直接 JSON.stringify 会误判 modified。 */
export function sameConfig(a: unknown, b: unknown): boolean {
  return JSON.stringify(sortKeys(a)) === JSON.stringify(sortKeys(b));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(Object.keys(v as Record<string, unknown>).sort().map((k) => [k, sortKeys((v as Record<string, unknown>)[k])]));
  }
  return v;
}
