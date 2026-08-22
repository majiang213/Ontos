// 配置存储 —— M4 雏形。工作副本（草稿）与已发布版本的唯一出入口。
// 画布读写副本；引擎只读已发布。已发布配置与版本链存共享元库（onto_version，按 workspace_id 隔离）；
// 发布 = 校验 + 插入新版行（git revert 语义，历史链不断）。摆位存 onto_workspace.layout。

import { dump, load } from "js-yaml";
import { configSchema, type OntologyConfig, type ObjectType } from "../schema/config";
import { draftObjectSchema, type DraftOpInput as DraftOp } from "../schema/ops";
import { metaStore } from "../meta/store";
import { linkRefs, referencesOf } from "./refs";
import { runtime } from "../runtime";
import { validateActionShapes, validateSemantics } from "./validate";
import { DEFAULT_WS, seedYamlFor } from "./workspace";

/* ---------- 已发布 ---------- */

export interface DraftState {
  draft: OntologyConfig;
  baseVersion: number; // 基于哪个已发布版本
  dirty: boolean; // 与已发布是否有差异（按结构比较，每次操作后重算）
  layout: Record<string, { x: number; y: number }>; // 画布摆位（存 onto_workspace.layout 的 nodes）
  edgeBends: Record<string, { dx: number; dy: number }>; // 线的弯折（存同一列的 edges）；界面状态，不算本体改动
}

export interface Store {
  published?: { config: OntologyConfig; version: number };
  draft?: DraftState; // DraftState 不加 rev：discard 会清空、rollback 会整份换 draft 对象，rev 挂 Store 上才能只加不回零
  rev: number; // 进程内单调，只加不回零；新建 Store 为 0。画布监视器与 MCP base_rev 都读它
}
// 每个工作空间一份内存态（已发布快照 + 工作副本），互不串；挂运行态（runtime.ts）
function storeOf(ws: string): Store {
  const stores = (runtime().stores ??= new Map());
  let s = stores.get(ws);
  if (!s) {
    s = { rev: 0 };
    stores.set(ws, s);
  }
  return s;
}

/** 草稿修订号：内容每变一次 +1（含发布/放弃/回滚），只加不回零；save_layout 不算。GET /api/ontology、list_classes space=draft、apply_draft 与 base_rev 比较一律读它。 */
export function getRev(ws: string = DEFAULT_WS): number {
  return storeOf(ws).rev;
}

/* 每工作空间一条写队列：applyOp 校验之后有 await（摆位/取已发布），两个请求在 await 处交错时备份回退会对错对象。
   失败也续链（prev.then(task, task)）：前一次 DraftReject 不拖死后续写入。全仓只有这一层队列——MCP / REST 不许再套。 */
const tails = new Map<string, Promise<void>>();

function enqueue<T>(ws: string, task: () => Promise<T>): Promise<T> {
  const prev = tails.get(ws) ?? Promise.resolve();
  const run = prev.then(task, task); // 前一次拒绝也跑这一次
  tails.set(ws, run.then(() => undefined, () => undefined)); // 只续链，吞掉结果；拒绝仍传给调用方
  return run;
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
    const { nodes, edges } = await metaStore().getLayout(ws);
    store.draft = { draft: structuredClone(config), baseVersion: version, dirty: false, layout: nodes, edgeBends: edges };
  }
  store.draft.edgeBends ??= {}; // 热更新前建的内存态没有这字段
  return store.draft;
}

/* ---------- 编辑操作（作用于工作副本） ---------- */

export class DraftReject extends Error {} // 操作不合法：名字重了、对象不存在等

/** 整份替换（replace_object）的锁定规则，与 read_class space=draft 的 replaceable/replace_blockers 共用——读路径和写路径不写两份文案。
 *  命中一条即锁定。集合非空一律用 Object.keys 计数：actions: {} / axioms: {} 在 JS 里为真，LLM 草稿常带空 map，不能当真值误锁。 */
export function replaceBlockers(existing: ObjectType, publishedHasClass: boolean): string[] {
  const reasons: string[] = [];
  if (publishedHasClass) reasons.push("已经发布过");
  if (Object.values(existing.properties).some((p) => p.derived)) reasons.push("含派生字段");
  if (Object.keys(existing.actions ?? {}).length > 0) reasons.push("含动作");
  if (Object.keys(existing.axioms ?? {}).length > 0) reasons.push("含公理");
  const sources = Object.values(existing.sources ?? {});
  if (sources.length > 1) reasons.push("挂了多个来源");
  if (sources.length >= 1) {
    // 「未对照到表列的字段」只锁挂了来源的类：没挂来源的残缺生成（猜不到识别字段时不写 sources）正是整份替换要救的
    const mapped = new Set(sources.flatMap((s) => Object.keys(s.fields)));
    if (Object.entries(existing.properties).some(([p, def]) => !def.derived && !mapped.has(p))) reasons.push("含有未对照到表列的字段");
  }
  return reasons;
}

export async function applyOp(input: DraftOp, ws: string = DEFAULT_WS, opts?: { base_rev?: number }): Promise<DraftState> {
  return enqueue(ws, async () => {
  // base_rev 只在 MCP 信封出现（REST 画布不传，队列里后到的写入赢）；比较必须在同一个 task 开头——比在队列外会被并发吞掉
  if (opts?.base_rev !== undefined && opts.base_rev !== getRev(ws)) {
    throw new DraftReject(`草稿已变（rev=${getRev(ws)}），请重新读取再改`);
  }
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
      if (t.identity === input.name) throw new DraftReject("认出同一对象靠的字段不能直接删，先换一个");
      const refs = referencesOf(d, input.object, input.name);
      if (refs.length) throw new DraftReject(`${input.name} 仍被引用：${refs.join("、")}`);
      delete t.properties[input.name];
      break;
    }
    case "update_property": {
      const t = mustType(d, input.object);
      const prop = t.properties[input.name];
      if (!prop) throw new DraftReject(`属性不存在：${input.name}`);
      if (input.description !== undefined) prop.description = input.description || undefined; // 空串 = 清掉
      if (input.type !== undefined && input.type !== prop.type) {
        prop.type = input.type;
        if (input.type !== "enum") delete prop.values; // 类型离开 enum，枚举值跟着清
      }
      if (input.values !== undefined) prop.values = input.values.length ? input.values : undefined; // 空数组 = 清掉
      if (input.new_name && input.new_name !== input.name) {
        if (!/^[a-z][a-z0-9_]*$/.test(input.new_name)) throw new DraftReject("属性名必须是小写字母/数字/下划线，字母开头");
        if (t.properties[input.new_name]) throw new DraftReject(`属性已存在：${input.new_name}`);
        const refs = referencesOf(d, input.object, input.name); // 被引用（源映射/关系/派生/动作）的属性改名会断链，拒
        if (refs.length) throw new DraftReject(`${input.name} 仍被引用：${refs.join("、")}，先解除引用再改名`);
        t.properties[input.new_name] = prop;
        delete t.properties[input.name];
        if (t.identity === input.name) t.identity = input.new_name; // 唯一键指针跟着走
      }
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
      await metaStore().setLayout(ws, { nodes: state.layout, edges: state.edgeBends }); // 摆位入库（onto_workspace.layout），重启不丢
      return state; // 摆位不算本体改动，不碰 dirty
    }
    case "save_edge_bend": {
      if (!state.draft.link_types[input.name]) throw new DraftReject(`关系不存在：${input.name}`);
      if (input.bend) state.edgeBends[input.name] = input.bend; else delete state.edgeBends[input.name]; // null = 拉直
      await metaStore().setLayout(ws, { nodes: state.layout, edges: state.edgeBends });
      return state; // 与摆位同理：界面状态，不碰 dirty、不过语义校验
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
    case "update_link": {
      const l = d.link_types[input.name];
      if (!l) throw new DraftReject(`关系不存在：${input.name}`);
      if (input.from !== undefined || input.to !== undefined) {
        // 画布拖边改接：先全部校验再落笔，配对字段跟着新端点修——还存在的留，留不下的用两边唯一键（或首个属性）重配
        const from = input.from ?? l.from;
        const to = input.to ?? l.to;
        if (l.transition) throw new DraftReject("转化关系的两端不能改接");
        if (from === to) throw new DraftReject("关系的两端不能是同一个对象");
        const refs = linkRefs(d, input.name); // 改端点与改名同理：引用它的动作按 from/to 走线，会静默断
        if (refs.length) throw new DraftReject(`${input.name} 仍被引用：${refs.join("、")}，先改引用它的动作再改接`);
        const fromT = mustType(d, from);
        const toT = mustType(d, to);
        let match = l.match;
        if (match) {
          match = match.filter((m) => fromT.properties[m.from] && toT.properties[m.to]);
          if (!match.length) {
            const f = fromT.identity ?? Object.keys(fromT.properties)[0];
            const t = toT.identity ?? Object.keys(toT.properties)[0];
            if (!f || !t) throw new DraftReject("新端点上没有任何属性，配不出配对字段");
            match = [{ from: f, to: t }];
          }
        }
        l.from = from;
        l.to = to;
        if (match) l.match = match;
      }
      if (input.description !== undefined) l.description = input.description || undefined; // 空串 = 清掉
      if (input.inverse !== undefined) {
        if (input.inverse && !/^[a-z][a-z0-9_]*$/.test(input.inverse)) throw new DraftReject("反向名必须是小写字母/数字/下划线，字母开头");
        l.inverse = input.inverse || undefined; // 空串 = 清掉
      }
      if (input.new_name && input.new_name !== input.name) {
        if (!/^[a-z][a-z0-9_]*$/.test(input.new_name)) throw new DraftReject("关系名必须是小写字母/数字/下划线，字母开头");
        if (d.link_types[input.new_name]) throw new DraftReject(`关系已存在：${input.new_name}`);
        const refs = linkRefs(d, input.name); // 改名即引用断链——被动作/派生引用的关系拒改
        if (refs.length) throw new DraftReject(`${input.name} 仍被引用：${refs.join("、")}，先改引用它的动作再改名`);
        d.link_types[input.new_name] = l;
        delete d.link_types[input.name];
      }
      break;
    }
    case "import_objects": {
      // 先全量预检再一次落草稿：循环里半途抛错不会留下前几个类（孤儿对象会随下次发布混出去）
      const staged: [string, OntologyConfig["object_types"][string]][] = [];
      for (const [name, raw] of Object.entries(input.objects)) {
        if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new DraftReject(`类名必须是小写字母/数字/下划线，字母开头：${name}`);
        if (d.object_types[name]) throw new DraftReject(`类已存在：${name}`);
        staged.push([name, draftObjectSchema.parse(raw)]); // 逐类过结构校验；草稿路径剥掉 actions/axioms（动作只走 set_action）
      }
      for (const [name, obj] of staged) d.object_types[name] = obj;
      break;
    }
    case "replace_object": {
      // 整份替换未锁定的类：关系留在 link_types（不走 dropClass），摆位不动；替换后 match 断了由 validateSemantics 整步回退
      const cur = d.object_types[input.name];
      if (!cur) throw new DraftReject(`类不存在：${input.name}，新建请用 import_objects`);
      const publishedHas = Boolean((await getPublished(ws)).config.object_types[input.name]);
      const blockers = replaceBlockers(cur, publishedHas);
      if (blockers.length) throw new DraftReject(`${input.name} 不能整对象替换：${blockers.join("；")}。请用增删字段等逐步操作`);
      d.object_types[input.name] = input.def; // Zod 已在 schema 层 parse（并剥掉 actions/axioms）
      break;
    }
    case "set_action": {
      // 单条 upsert：同名覆盖、不同名新增。def 已在 schema 层过 actionSchema；形状四查在 validateActionShapes
      const t = d.object_types[input.object];
      if (!t) throw new DraftReject(`类不存在：${input.object}，新建类请先 import_objects`);
      t.actions ??= {};
      t.actions[input.name] = input.def;
      break;
    }
    case "remove_action": {
      const t = mustType(d, input.object);
      if (!t.actions?.[input.name]) throw new DraftReject(`动作不存在：${input.name}`);
      delete t.actions[input.name];
      if (Object.keys(t.actions).length === 0) delete t.actions; // 空 map 会让 sameConfig 的 dirty 收不回来，删干净
      break;
    }
    default:
      throw new DraftReject(`未知操作：${JSON.stringify(input)}`);
  }
  // 每步操作后立即语义校验，不合法整体回退——坏草稿（如 fields 指向不存在属性的导入）不能攒到发布一刻才炸
  try {
    const parsed = configSchema.parse(structuredClone(state.draft));
    validateSemantics(parsed);
    validateActionShapes(parsed); // 动作形状四查只走草稿写入/发布路径；loadPublished/rollbackTo 不查（历史坏配置加载放行）
  } catch (e) {
    state.draft = backup;
    throw new DraftReject(e instanceof Error ? e.message : String(e));
  }
  // rev += 1 必须在内容写进 Store 之后、下一个 await 之前——晚一拍，监视器带旧 ETag 会 304，把已改的草稿当成没变
  storeOf(ws).rev += 1;
  // 校验过了再清界面状态：对象没了清摆位、关系没了清弯折（校验失败回退时不丢）
  {
    let layoutChanged = false;
    for (const name of Object.keys(state.layout)) {
      if (!state.draft.object_types[name]) { delete state.layout[name]; layoutChanged = true; }
    }
    for (const name of Object.keys(state.edgeBends)) {
      if (!state.draft.link_types[name]) { delete state.edgeBends[name]; layoutChanged = true; }
    }
    if (layoutChanged) await metaStore().setLayout(ws, { nodes: state.layout, edges: state.edgeBends });
  }
  // 每次操作后按结构重算：改出去又改回来，dirty 要能收回来
  state.dirty = !sameConfig(state.draft, (await getPublished(ws)).config);
  return state;
  });
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

/** 直接改草稿（裁决应用等成组改动走这里）：改完立即校验，不合法就回退并抛 DraftReject——不让坏草稿攒到发布一刻才炸。 */
export async function mutateDraft(fn: (draft: OntologyConfig) => void, ws: string = DEFAULT_WS): Promise<DraftState> {
  return enqueue(ws, async () => {
  const state = await getDraft(ws);
  const backup = structuredClone(state.draft);
  try {
    fn(state.draft);
    const parsed = configSchema.parse(structuredClone(state.draft));
    validateSemantics(parsed);
    validateActionShapes(parsed); // 与 applyOp 同闸：裁决产物也得过动作形状四查
  } catch (e) {
    state.draft = backup; // 回退
    throw new DraftReject(e instanceof Error ? e.message : String(e));
  }
  // rev += 1 必须在内容写进 Store 之后、下一个 await 之前（与 applyOp 同约定）
  storeOf(ws).rev += 1;
  // 被撤的类顺手清摆位、被撤的关系清弯折（裁决的 dropClass 不走 delete_object），摆位表不留死键
  {
    let layoutChanged = false;
    for (const name of Object.keys(state.layout)) {
      if (!state.draft.object_types[name]) { delete state.layout[name]; layoutChanged = true; }
    }
    for (const name of Object.keys(state.edgeBends)) {
      if (!state.draft.link_types[name]) { delete state.edgeBends[name]; layoutChanged = true; }
    }
    if (layoutChanged) await metaStore().setLayout(ws, { nodes: state.layout, edges: state.edgeBends });
  }
  state.dirty = !sameConfig(state.draft, (await getPublished(ws)).config);
  return state;
  });
}

/* ---------- 发布与放弃 ---------- */

export async function publishDraft(ws: string = DEFAULT_WS): Promise<{ version: number }> {
  return enqueue(ws, async () => {
  const state = await getDraft(ws);
  if (!state.dirty) return { version: state.baseVersion }; // 无改动不产空版本
  const config = configSchema.parse(structuredClone(state.draft)); // 结构校验
  try {
    validateSemantics(config); // 语义校验
    validateActionShapes(config); // 动作形状四查（效应 link/转化成对/取值来源/认人写明）
  } catch (e) {
    throw new DraftReject(e instanceof Error ? e.message : String(e)); // 归一到类型，路由不用嗅探文案
  }
  const version = (await metaStore().latestVersion(ws, seedYamlFor(ws))).version + 1; // 版本号以库里的链为准
  await metaStore().insertVersion(ws, version, dump(config, { lineWidth: 120, noRefs: true }), "publish");
  storeOf(ws).published = { config, version }; // 换掉已发布快照：引擎下一次 getPublished 即读新版
  state.baseVersion = version;
  state.dirty = false;
  // rev += 1：store 写完、下一个 await（fillDecisionVersions）之前——给监视器与 base_rev 留的窗口在这里收掉
  storeOf(ws).rev += 1;
  await fillDecisionVersions(version, ws); // 裁决留痕的生效版本随发布回填
  return { version };
  });
}

export async function discardDraft(ws: string = DEFAULT_WS): Promise<void> {
  return enqueue(ws, async () => {
  storeOf(ws).draft = undefined; // 回到已发布快照；摆位在库里，不随草稿丢
  // rev += 1 必须在内容写进 Store 之后、下一个 await 之前（放弃也是内容变化：监视器要靠它刷回已发布）
  storeOf(ws).rev += 1;
  try {
    await metaStore().abandonPendingDecisions(ws); // 草稿里裁过又没发布的留痕标记「已放弃」，不挂到无关的下一次发布上
  } catch {
    // 留痕是附属，不挡放弃
  }
  });
}

/* ---------- 版本历史与回滚 ---------- */

export function listVersions(ws: string = DEFAULT_WS): Promise<{ version: number; createdAt: string; origin: string }[]> {
  return metaStore().listVersions(ws);
}

/** 回滚 = Git revert 语义：把旧版本内容作为新版本插入，历史链不断。草稿有未发布改动时拒绝，先发布或放弃。 */
export async function rollbackTo(version: number, ws: string = DEFAULT_WS): Promise<{ version: number }> {
  return enqueue(ws, async () => {
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
  const { nodes, edges } = await metaStore().getLayout(ws); // 先取摆位：store 写入要成片完成，中途不夹 await
  storeOf(ws).published = { config, version: newVersion };
  storeOf(ws).draft = { draft: structuredClone(config), baseVersion: newVersion, dirty: false, layout: nodes, edgeBends: edges };
  // rev += 1 必须在内容写进 Store 之后、下一个 await 之前（干净草稿 rev=0 时回滚也要 +1，监视器按相等比较）
  storeOf(ws).rev += 1;
  await fillDecisionVersions(newVersion, ws); // 回滚也是一次发布：未绑版本的裁决挂到它
  return { version: newVersion };
  });
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
