// 定案应用 —— 把对齐裁决写成配置（《ontos-article.md》§3.2）。
// 类等价：合并为一个对象、挂多源。生命周期：收成一类 + 派生阶段 + 转化关系 + 转化动作。
// 部分重叠：同一概念的表并成一个多源类（来源覆盖面差异是数据事实，ADR 0013 再修订）。
// 同形异义：两类都留下。跳过：不是类与类关系，配置不动。结论与证据住裁决工作记录（adj_decision），不进配置。
// 骨架（conversionAction / set_fields）的唯一构造点在 draft/skeletons.ts，这里只消费。

import type { ActionDef, OntologyConfig, WhenRule } from "../../schema/config";
import { resolveLink, walkFilter } from "../../schema/spec/filterSpec";
import { walkEffectItems } from "../../schema/spec/actionSpec";
import { dropClass } from "../ontology/ops/editObject";
import { mutateDraft } from "../ontology/editDraft";
import { conversionAction, conversionActionName } from "../ontology/skeletons";
import type { EngineEnv } from "../env";
import { FALLBACK_STAGE_LABELS, Verdict, executionPlan, stageValues } from "../../schema/verdict";
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
    case Verdict.Overlap: {
      // 同一概念的表并成一个多源类（来源覆盖面差异是数据事实，ADR 0013 再修订）——判定归 Agent：
      // 它按行的性质判"是同一概念"才走到这里；合并 = B 的源挂到 A、B 消亡，两类一落法
      mergeInto(d, a, b);
      break;
    }
    case Verdict.Skip:
      break; // 不是类与类关系，配置不动
    case Verdict.NameSimilar:
      // 两类都留下；结论与证据住裁决留痕（adj_decision），不进本体配置
      break;
    case Verdict.Stage: {
      // 时期标识的兜底单源在 executionPlan（schema/verdict）：缺时期名时用中性占位 early/late，不在这里再造一套
      const plan = executionPlan(a, b, Verdict.Stage, {});
      const from = stageNames?.from ?? plan.stage!.from;
      const to = stageNames?.to ?? plan.stage!.to;
      const A = d.object_types[a];
      if (!A || !d.object_types[b]) throw new Error(MSG.classPairNotFound(a, b));
      // 并前先取 status：B 的状态列拷进来不算「已有时期」——数据列的归宿是改名让位（如 mark），不是被派生顶掉
      const statusBefore = A.properties.status;
      const adopting = statusBefore?.type === "enum" && Array.isArray(statusBefore.derived) && statusBefore.derived.length > 0;
      // 先并属性与源（与类等价同款），再立生命周期结构
      const srcKeysBefore = new Set(Object.keys(A.sources ?? {}));
      mergeInto(d, a, b);
      const newKeys = Object.keys(A.sources ?? {}).filter((k) => !srcKeysBefore.has(k));
      const srcA = Object.keys(A.sources ?? {})[0];
      const srcB = newKeys[0] ?? srcA; // B 并进来的第一个源条目
      if (!srcA || !srcB || srcA === srcB) throw new Error(MSG.stageNeedsTwoSources);
      // 撞名不静默覆盖：同名关系 / 同名动作时让人先改名
      if (d.link_types[`${a}_to_${to}`]) throw new Error(MSG.stageLinkNameClash(`${a}_to_${to}`));
      if (A.actions?.[conversionActionName(to)]) throw new Error(MSG.stageActionNameClash(conversionActionName(to)));
      if (adopting && statusBefore) {
        // 多段时期（在途→在役→已处置…）：采纳既有 status——新源是新的一段，规则前插（先命中先赢），值缺就补
        const derived = statusBefore.derived as { when: WhenRule["when"]; value: string }[];
        statusBefore.derived = [{ when: { [srcB]: true }, value: to }, ...derived];
        const vals = [...(statusBefore.values ?? [])];
        if (!vals.some((v) => (v !== null && typeof v === "object" ? v.value : v) === to)) {
          const label = FALLBACK_STAGE_LABELS[to];
          vals.push(label ? { value: to, label } : { value: to });
        }
        statusBefore.values = vals;
      } else {
        // 第一段时期：新建 status（占位词带中文名（早期/晚期），建议词裸 key（中文名由改标识补））
        if (A.properties.status) throw new Error(MSG.stageStatusClash(a));
        A.properties.status = {
          type: "enum",
          values: stageValues(from, to),
          description: "阶段",
          derived: [
            { when: { [srcA]: true, [srcB]: false }, value: from },
            { when: { [srcB]: true }, value: to },
          ],
        };
      }
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
  }
}

/** 事务入口：走 draft 包的草稿变更通道（dirty 重算 + 立即校验，不合法则回退）。 */
export function adjudicate(env: EngineEnv, pair: { class_a: string; class_b: string }, verdict: Verdict, stageNames?: { from: string; to: string }, workspace?: string): Promise<void> {
  return mutateDraft(env, (d) => applyVerdict(d, pair, verdict, stageNames), workspace).then(() => undefined);
}
