// 定案应用 —— 把对齐裁决写成配置（《ontos-article.md》§3.2）。
// 类等价：合并为一个对象、挂多源。生命周期：收成一类 + 派生阶段 + 转化关系 + 转化动作。
// 部分重叠：同名公共属性立公共对象（移上去，识别字段复制不移动）；没有同名则公共对象只带唯一键；写入 class_conclusions。
// 同形异义：两类都留下，写入 class_conclusions。跳过：不是类与类关系，配置不动。
// 骨架（conversionAction / set_fields）的唯一构造点在 draft/skeletons.ts，这里只消费。

import type { ActionDef, OntologyConfig, WhenRule } from "../../schema/config";
import { resolveLink, walkFilter } from "../../schema/spec/filterSpec";
import { walkEffectItems } from "../../schema/spec/actionSpec";
import { dropClass } from "../ontology/ops/editObject";
import { mutateDraft } from "../ontology/editDraft";
import { conversionAction, conversionActionName, removeFieldsUpdateKeys } from "../ontology/skeletons";
import { sharedObjectName } from "../ontology/sharedName";
import type { EngineEnv } from "../env";
import { commonProperties } from "./eligibility";
import { Verdict, executionPlan, stageValues } from "../../schema/verdict";
import { MSG } from "../../errors";

export type { Verdict } from "../../schema/verdict";

/** B 的属性并入 A（同名跳过、特有带过来），B 的源映射照搬，B 挂着的关系撤掉。
 *  识别属性不同名时（A.sn × B.serial_no）：B 的识别属性不另立，B 源条目的 fields 键改写为 A 的识别属性——
 *  两识别字段同义正是「类等价/生命周期」的裁决前提，不改写则 fields 缺 A.identity 的映射，过不了发布校验。 */
function mergeInto(d: OntologyConfig, a: string, b: string): void {
  const A = d.object_types[a];
  const B = d.object_types[b];
  if (!A || !B) throw new Error(MSG.classPairNotFound(a, b));
  const remapId = A.identity && B.identity && A.identity !== B.identity ? B.identity : undefined;
  for (const [prop, def] of Object.entries(B.properties)) {
    if (prop === remapId) continue; // B 的识别属性并入 A 的识别属性，不另立
    if (!A.properties[prop]) A.properties[prop] = def;
  }
  A.sources = A.sources ?? {};
  const renamed = new Map<string, string>(); // B 的源条目旧名 → 并进 A 后的新名
  for (const [srcName, entry] of Object.entries(B.sources ?? {})) {
    const newName = A.sources[srcName] ? `${srcName}_${b}` : srcName;
    if (newName !== srcName) renamed.set(srcName, newName);
    const fields = { ...entry.fields };
    if (remapId && fields[remapId]) {
      fields[A.identity!] = fields[remapId];
      delete fields[remapId];
    }
    // 源条目的 key 若正是 B 的识别属性，随 remap 一并改到 A 的识别属性
    const key = entry.key === remapId ? A.identity : entry.key;
    A.sources[newName] = { ...entry, fields, key };
  }
  // B 带来的派生属性：when 规则的源键随源条目改名改写，不然规则静默死掉
  if (renamed.size > 0) {
    for (const [prop, def] of Object.entries(B.properties)) {
      if (prop === remapId || A.properties[prop] !== def) continue; // 只处理真正并进来的
      if (Array.isArray(def.derived)) {
        for (const rule of def.derived) {
          rule.when = Object.fromEntries(Object.entries(rule.when).map(([k, v]) => [renamed.get(k) ?? k, v])) as WhenRule["when"];
        }
      }
    }
  }
  // B 的动作与公理带过来（同名跳过；随 B 消亡的动作跳过——见 actionDiesWith：跟过去必炸校验、整步回退，
  // 人的裁决关卡无解。先阶段后合并的多跳裁决下 B 的 convert_to_* 随 B 的转化关系消亡，只是其中一种死法）
  if (B.actions) {
    A.actions = A.actions ?? {};
    for (const [name, act] of Object.entries(B.actions)) {
      if (A.actions[name]) continue;
      if (actionDiesWith(d, b, act, b, remapId)) continue;
      A.actions[name] = act;
    }
  }
  if (B.axioms) {
    A.axioms = A.axioms ?? {};
    for (const [name, ax] of Object.entries(B.axioms)) if (!A.axioms[name]) A.axioms[name] = ax;
  }
  dropClass(d, b);
}

/** 动作是否随 dying 类消亡（合并时不搬进留下类——跟过去必炸 validateSemantics/validateActionShapes，整步回退）：
 *  ① 引用将消亡的关系（pre / 效应 filter 的 $link、效应 link 项：dropClass 撤掉 from/to 含 dying 的全部关系）；
 *  ② 引用 dying 类本身：效应（update/delete/create）或 inform 的对象是 dying；$request 的认人对象是 dying；
 *  ③ 读写 remapId（B 的识别属性不并过来，留下类上没有这个键）：pre / 效应 filter 的键侧与 {property} 值侧。
 *     （inform 值侧不用查：位置规则禁 from: current，{property} 只能读请求袋，引用 dying 类的形状写不出来。） */
function actionDiesWith(d: OntologyConfig, owner: string, act: ActionDef, dying: string, remapId?: string): boolean {
  let hit = false;
  const collect = (clsName: string, f: Record<string, unknown> | undefined) => {
    if (!f || hit) return;
    walkFilter(d, clsName, f, {
      link: (cls, ln) => {
        const r = resolveLink(d, cls, ln);
        if (!r || r.link.from === dying || r.link.to === dying) hit = true;
      },
      prop: (_cls, key, v) => {
        if (key === remapId) hit = true; // 键侧：过滤了 B 的识别属性（不并过来）
        if (remapId && v !== null && typeof v === "object" && !Array.isArray(v) && (v as Record<string, unknown>).property === remapId) hit = true; // 值侧：读 B 的识别属性
      },
      special: (_c, k, v) => {
        if (k !== "$request" || !v || typeof v !== "object") return;
        for (const cv of Object.values(v as Record<string, unknown>)) {
          if (cv !== null && typeof cv === "object" && (cv as Record<string, unknown>).object === dying) hit = true; // $request 认人认到 dying 类
        }
      },
    });
  };
  collect(owner, act.pre as Record<string, unknown> | undefined);
  walkEffectItems(act, {
    link: (name) => {
      const l = d.link_types[name];
      if (!l || l.from === dying || l.to === dying) hit = true;
    },
    update: (item) => {
      if (item.object === dying) hit = true; // 效应指向 dying 类（set_fields 效应恒为宿主类，B 的一搬必炸）
      else collect(item.object, item.filter as Record<string, unknown> | undefined);
    },
    create: (item) => {
      if (item.object === dying) hit = true;
    },
    delete: (item) => {
      if (item.object === dying) hit = true;
      else collect(item.object, item.filter as Record<string, unknown> | undefined);
    },
  });
  if (!hit) {
    for (const inf of act.inform ?? []) {
      if (inf.object === dying) { hit = true; break; } // 告知对象是 dying 类
      // inform 值侧不查：inform.properties 位置规则禁 from: current（validateActionShapes ③），
      // {property} 只能 from: request（读请求袋，不读类）——值侧引用 dying 类的形状根本写不出来
    }
  }
  return hit;
}

export function applyVerdict(d: OntologyConfig, pair: { class_a: string; class_b: string }, verdict: Verdict, stageNames?: { from: string; to: string }): void {
  const { class_a: a, class_b: b } = pair;
  switch (verdict) {
    case Verdict.Same:
      mergeInto(d, a, b);
      break;
    case Verdict.Skip:
      break; // 不是类与类关系，配置不动
    case Verdict.NameSimilar:
      // 两类都留下；结论写进 class_conclusions，问数/动作/画布才读得到
      (d.class_conclusions ??= []).push({ kind: "homonym", classes: [a, b].sort() });
      break;
    case Verdict.Stage: {
      // 时期标识的兜底单源在 executionPlan（schema/verdict）：缺时期名时用中性占位 early/late，不在这里再造一套
      const plan = executionPlan(a, b, Verdict.Stage, {});
      const from = stageNames?.from ?? plan.stage!.from;
      const to = stageNames?.to ?? plan.stage!.to;
      const A = d.object_types[a];
      if (!A || !d.object_types[b]) throw new Error(MSG.classPairNotFound(a, b));
      // 先并属性与源（与类等价同款），再立生命周期结构
      const srcKeysBefore = new Set(Object.keys(A.sources ?? {}));
      mergeInto(d, a, b);
      const newKeys = Object.keys(A.sources ?? {}).filter((k) => !srcKeysBefore.has(k));
      const srcA = Object.keys(A.sources ?? {})[0];
      const srcB = newKeys[0] ?? srcA; // B 并进来的第一个源条目
      if (!srcA || !srcB || srcA === srcB) throw new Error(MSG.stageNeedsTwoSources);
      // 撞名不静默覆盖：合并后已有 status 属性 / 同名关系 / 同名动作时让人先改名
      if (A.properties.status) throw new Error(MSG.stageStatusClash(a));
      if (d.link_types[`${a}_to_${to}`]) throw new Error(MSG.stageLinkNameClash(`${a}_to_${to}`));
      if (A.actions?.[conversionActionName(to)]) throw new Error(MSG.stageActionNameClash(conversionActionName(to)));
      A.properties.status = {
        type: "enum",
        values: stageValues(from, to), // 占位词带中文名（早期/晚期），建议词裸 key（中文名由改标识补）
        description: "阶段",
        derived: [
          { when: { [srcA]: true, [srcB]: false }, value: from },
          { when: { [srcB]: true }, value: to },
        ],
      };
      d.link_types[`${a}_to_${to}`] = {
        from: a,
        to: a,
        inverse: `${a}_from_${from}`,
        card: "1:1",
        transition: { property: "status", from, to },
      };
      A.actions = A.actions ?? {};
      A.actions[conversionActionName(to)] = conversionAction(`${a}_to_${to}`, d.link_types[`${a}_to_${to}`]);
      break;
    }
    case Verdict.Overlap: {
      // 公共属性立上位对象：属性移上去，识别字段复制不移动（移了原类悬空）
      const A = d.object_types[a];
      const B = d.object_types[b];
      if (!A || !B) throw new Error(MSG.classPairNotFound(a, b));
      const idProps = new Set([A.identity, B.identity].filter(Boolean) as string[]);
      const common = commonProperties(A, B); // 同名才上移；没有同名不挡——公共对象只带唯一键
      const shared = sharedObjectName(a, b);
      // 上位对象的源：公共列 + 识别列（识别列是读公共属性的对齐齐）
      const sharedSources: NonNullable<OntologyConfig["object_types"][string]["sources"]> = {};
      for (const [side, cls] of [["a", A], ["b", B]] as const) {
        for (const [srcName, entry] of Object.entries(cls.sources ?? {})) {
          const keep = [...common, ...idProps].filter((p) => entry.fields[p]);
          if (keep.length === 0) continue;
          const fields = Object.fromEntries(keep.map((p) => [p, entry.fields[p]]));
          // 该侧源条目映射到的识别属性显式写进 key——上位对象的 identity 只取其一，另一侧靠 key 认行
          const sideId = [...idProps].find((p) => fields[p]);
          sharedSources[sharedSources[srcName] ? `${srcName}_${side}` : srcName] = { ...entry, fields, key: sideId };
        }
      }
      const sharedProps: OntologyConfig["object_types"][string]["properties"] = {};
      for (const p of common) {
        sharedProps[p] = A.properties[p];
        delete A.properties[p];
        delete B.properties[p];
        for (const entry of Object.values(A.sources ?? {})) delete entry.fields[p];
        for (const entry of Object.values(B.sources ?? {})) delete entry.fields[p];
      }
      removeFieldsUpdateKeys(a, A, common); // 公共属性挪到上位对象，set_fields 摘键（摘空整条撤掉）
      removeFieldsUpdateKeys(b, B, common);
      // 识别属性复制给上位对象（不移动）
      for (const p of idProps) {
        const def = A.properties[p] ?? B.properties[p];
        if (def) sharedProps[p] = def;
      }
      d.object_types[shared] = {
        kind: "thing",
        description: `${a} 与 ${b} 的公共部分`,
        identity: [...idProps][0],
        properties: sharedProps,
        sources: sharedSources,
      };
      (d.class_conclusions ??= []).push({ kind: "overlap", classes: [a, b].sort(), shared });
      break;
    }
  }
}

/** 事务入口：走 draft 包的草稿变更通道（dirty 重算 + 立即校验，不合法则回退）。 */
export function adjudicate(env: EngineEnv, pair: { class_a: string; class_b: string }, verdict: Verdict, stageNames?: { from: string; to: string }, workspace?: string): Promise<void> {
  return mutateDraft(env, (d) => applyVerdict(d, pair, verdict, stageNames), workspace).then(() => undefined);
}
