// 配置存储 —— M4 雏形。工作副本（草稿）与已发布版本的唯一出入口。
// 画布读写副本；引擎只读已发布。发布 = 校验 + 写版本文件 + 升版本（git revert 语义，历史链不断）。

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dump, load } from "js-yaml";
import { configSchema, type OntologyConfig } from "../schema/config";
import type { DraftOpInput as DraftOp } from "../schema/ops";
import { validateSemantics } from "./validate";

// 路径按 cwd 现算，不在模块顶层冻结：测试会切换工作目录，顶层常量会把第一轮的临时目录记死。
const configDir = () => join(process.cwd(), "lib/config");
const seedFile = () => join(configDir(), "ontology.yaml");
const versionsDir = () => join(configDir(), "versions");
const layoutFile = () => join(configDir(), "canvas-layout.json");

/* ---------- 已发布 ---------- */

function latestVersionFile(): { version: number; file: string } {
  if (!existsSync(versionsDir())) return { version: 1, file: seedFile() };
  const versions = readdirSync(versionsDir())
    .map((f) => /^v(\d+)\.yaml$/.exec(f)?.[1])
    .filter((v): v is string => Boolean(v))
    .map(Number)
    .sort((a, b) => a - b);
  if (versions.length === 0) return { version: 1, file: seedFile() };
  const v = versions[versions.length - 1];
  return { version: v, file: join(versionsDir(), `v${v}.yaml`) };
}

export function loadPublished(): { config: OntologyConfig; version: number } {
  const { version, file } = latestVersionFile();
  const config = configSchema.parse(load(readFileSync(file, "utf8")));
  validateSemantics(config);
  return { config, version };
}

/* ---------- 工作副本 ---------- */

export interface DraftState {
  draft: OntologyConfig;
  baseVersion: number; // 基于哪个已发布版本
  dirty: boolean; // 与已发布是否有差异（按结构比较，每次操作后重算）
  layout: Record<string, { x: number; y: number }>; // 画布摆位（随草稿走，落 layout.json）
}

interface Store {
  published?: { config: OntologyConfig; version: number };
  draft?: DraftState;
}
const g = globalThis as unknown as { __ontosStore?: Store };
const store: Store = g.__ontosStore ?? (g.__ontosStore = {});

export function getPublished(): { config: OntologyConfig; version: number } {
  if (!store.published) store.published = loadPublished();
  return store.published;
}

function loadLayout(): Record<string, { x: number; y: number }> {
  try {
    if (existsSync(layoutFile())) return JSON.parse(readFileSync(layoutFile(), "utf8"));
  } catch {
    // 摆位文件损坏不致命：忽略，重排即可
  }
  return {};
}

export function getDraft(): DraftState {
  if (!store.draft) {
    const { config, version } = getPublished();
    store.draft = { draft: structuredClone(config), baseVersion: version, dirty: false, layout: loadLayout() };
  }
  return store.draft;
}

/* ---------- 编辑操作（作用于工作副本） ---------- */

export class DraftReject extends Error {} // 操作不合法：名字重了、对象不存在等

export function applyOp(input: DraftOp): DraftState {
  const state = getDraft();
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
      delete d.object_types[input.name];
      delete state.layout[input.name]; // 顺手清摆位
      if (existsSync(layoutFile())) writeFileSync(layoutFile(), JSON.stringify(state.layout), "utf8");
      for (const [linkName, link] of Object.entries(d.link_types)) {
        if (link.from === input.name || link.to === input.name) delete d.link_types[linkName]; // 挂着的关系一并撤
      }
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
      writeFileSync(layoutFile(), JSON.stringify(state.layout), "utf8"); // 摆位落小文件，重启不丢
      return state; // 摆位不算本体改动，不碰 dirty
    }
    default:
      throw new DraftReject(`未知操作：${JSON.stringify(input)}`);
  }
  // 每次操作后按结构重算：改出去又改回来，dirty 要能收回来
  state.dirty = !sameConfig(state.draft, getPublished().config);
  return state;
}

function mustType(d: OntologyConfig, name: string) {
  const t = d.object_types[name];
  if (!t) throw new DraftReject(`类不存在：${name}`);
  return t;
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
  return refs;
}

/** 过滤的顶层属性键（$ 键不进）。 */
function filterTopKeys(f: Record<string, unknown>): string[] {
  return Object.keys(f).filter((k) => !k.startsWith("$"));
}

/** 派生定义里出现的属性键（when 过滤 + 布尔过滤，含 $link 嵌套的目标侧键归目标类）。 */
function derivedFilterKeys(derived: unknown): string[] {
  const keys: string[] = [];
  const walk = (f: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(f)) {
      if (k === "$link") for (const sub of Object.values(v as Record<string, unknown>)) if (sub && typeof sub === "object") walk(sub as Record<string, unknown>);
      else if (!k.startsWith("$")) keys.push(k);
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

/** 关系名 → 目标类：正向取 to，反向名（inverse）取 from。 */
function linkTarget(d: OntologyConfig, hostCls: string, linkName: string): string | null {
  const direct = d.link_types[linkName];
  if (direct && direct.from === hostCls) return direct.to;
  for (const link of Object.values(d.link_types)) {
    if (link.inverse === linkName && link.to === hostCls) return link.from;
  }
  return null;
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

/* ---------- 发布与放弃 ---------- */

export function publishDraft(): { version: number } {
  const state = getDraft();
  if (!state.dirty) return { version: state.baseVersion }; // 无改动不产空版本
  const config = configSchema.parse(structuredClone(state.draft)); // 结构校验
  validateSemantics(config); // 语义校验
  const version = latestVersionFile().version + 1; // 版本号以磁盘链为准，防残留覆盖
  mkdirSync(versionsDir(), { recursive: true });
  const target = join(versionsDir(), `v${version}.yaml`);
  writeFileSync(`${target}.tmp`, dump(config, { lineWidth: 120, noRefs: true }), "utf8"); // 先写临时文件再改名，防半截文件
  renameSync(`${target}.tmp`, target);
  store.published = { config, version }; // 引擎下一次 loadPublished 即读新版
  state.baseVersion = version;
  state.dirty = false;
  return { version };
}

export function discardDraft(): void {
  store.draft = undefined; // 回到已发布快照；摆位存在独立小文件里，不随草稿丢
}

/** 测试用：清空内存态。 */
export function resetStore(): void {
  store.published = undefined;
  store.draft = undefined;
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
