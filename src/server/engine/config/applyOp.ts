// op 解释器 —— 草稿 18 个编辑 op 的逐一解释（唯一解释点：REST 画布与 MCP apply_draft 同走这里）。
// 只做内存修改：18 种 op 全归这里（含 save_* 的摆位/弯折/钉点）；落库与收尾方式由 applyDraft 按 ops.ts 的 UI_STATE_OPS 分流。
// 认人/引用/锁定三类共享原语（mustType / dropClass / replaceBlockers）住本文件，views 与裁决从这里取。

import type { ObjectType, OntologyConfig } from "../../schema/config";
import { draftObjectSchema, type DraftOpInput as DraftOp } from "../../schema/ops";
import { DraftReject } from "../../errors";
import { linkRefs, referencesOf } from "./refs";
import { FIELDS_UPDATE_ACTION, fieldsUpdateAction, removeFieldsUpdateKeys, renameFieldsUpdateKey } from "./skeletons";
import type { DraftState } from "./pack";

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

/** 解释一个 op：只改内存（state.draft 与界面状态三键）。落库、校验、rev、dirty 全由 applyDraft 决定。 */
export function applyOp(state: DraftState, input: DraftOp, published: OntologyConfig): void {
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
      if (t.identity === input.name) throw new DraftReject("唯一键不能直接删，先换一个");
      const refs = referencesOf(d, input.object, input.name).filter((r) => r !== `动作 ${input.object}.${FIELDS_UPDATE_ACTION}`);
      if (refs.length) throw new DraftReject(`${input.name} 仍被引用：${refs.join("、")}`);
      delete t.properties[input.name];
      removeFieldsUpdateKeys(input.object, t, [input.name]); // set_fields 摘键（摘空整条撤掉），不当引用拦删除
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
        const refs = referencesOf(d, input.object, input.name).filter((r) => r !== `动作 ${input.object}.${FIELDS_UPDATE_ACTION}`);
        if (refs.length) throw new DraftReject(`${input.name} 仍被引用：${refs.join("、")}，先解除引用再改名`); // 被引用（源映射/关系/派生/动作）的属性改名会断链，拒；set_fields 的键跟随，不算断链
        t.properties[input.new_name] = prop;
        delete t.properties[input.name];
        if (t.identity === input.name) t.identity = input.new_name; // 唯一键指针跟着走
        renameFieldsUpdateKey(input.object, t, input.name, input.new_name); // set_fields 的 properties 键跟着走
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
      state.layout = { ...state.layout, ...input.positions }; // 摆位只进内存；落库在 applyDraft 的界面状态分流
      break;
    }
    case "save_edge_bend": {
      if (!state.draft.link_types[input.name]) throw new DraftReject(`关系不存在：${input.name}`);
      if (input.bend) state.edgeBends[input.name] = input.bend; else delete state.edgeBends[input.name]; // null = 拉直
      break;
    }
    case "save_edge_pin": {
      if (!state.draft.link_types[input.name]) throw new DraftReject(`关系不存在：${input.name}`);
      const cur = { ...state.edgePins[input.name] };
      if (input.pin) cur[input.end] = input.pin; else delete cur[input.end]; // null = 回到浮动附着
      if (cur.source || cur.target) state.edgePins[input.name] = cur; else delete state.edgePins[input.name];
      break;
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
      if (input.match !== undefined) {
        // 改配对字段：与改两端同闸——转化关系没有配对、被引用的关系改了会静默变语义
        if (l.transition) throw new DraftReject("转化关系没有配对字段可改");
        const refs = linkRefs(d, input.name);
        if (refs.length) throw new DraftReject(`${input.name} 仍被引用：${refs.join("、")}，先改引用它的动作再改配对`);
        if (!d.object_types[l.from].properties[input.match.from]) throw new DraftReject(`${l.from} 上没有属性 ${input.match.from}`);
        if (!d.object_types[l.to].properties[input.match.to]) throw new DraftReject(`${l.to} 上没有属性 ${input.match.to}`);
        l.match = [{ from: input.match.from, to: input.match.to }];
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
      for (const [name, obj] of staged) {
        d.object_types[name] = obj;
        const skel = fieldsUpdateAction(name, obj); // 导入即带 set_fields（骨架唯一构造点）；无可写字段的类不补
        if (skel) d.object_types[name].actions = { [FIELDS_UPDATE_ACTION]: skel };
      }
      break;
    }
    case "replace_object": {
      // 整份替换未锁定的类：关系留在 link_types（不走 dropClass），摆位不动；替换后 match 断了由 validateSemantics 整步回退
      const cur = d.object_types[input.name];
      if (!cur) throw new DraftReject(`类不存在：${input.name}，新建请用 import_objects`);
      const publishedHas = Boolean(published.object_types[input.name]);
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
}
