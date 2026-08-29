// 改阶段 —— 派生 when 列表整份替换（条数随规则走）；时期名改了，转化关系与转化动作跟着换。

import type { ActionDef, LinkType } from "../../../schema/config";
import type { DraftOpInput as DraftOp } from "../../../schema/ops";
import { renameFilterLinks } from "../../../schema/spec/filterSpec";
import { walkEffectItems } from "../../../schema/spec/actionSpec";
import { DraftReject, MSG } from "../../../errors";
import { conversionAction, conversionActionName } from "../skeletons";
import { conversionActionOf, classStages } from "../stages";
import { renameEdgeState } from "../canvasState";
import type { DraftState } from "../canvasPack";
import { mustClass } from "./classMustExist";

type EditStagesOp = Extract<DraftOp, { op: "edit_stages" }>;

function rewriteStatusLiterals(pre: Record<string, unknown> | undefined, prop: string, map: Record<string, string>): void {
  if (!pre) return;
  const cur = pre[prop];
  if (typeof cur === "string" && map[cur]) pre[prop] = map[cur];
}

/** 条件等价键：键序无关（同一份条件两种写法视为同一条），对象逐层按键排序后序列化。 */
function whenKey(when: Record<string, unknown>): string {
  return JSON.stringify(sortKeys(when));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v === null || typeof v !== "object") return v;
  return Object.fromEntries(
    Object.entries(v as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, x]) => [k, sortKeys(x)])
  );
}

/** 引用跟随（保守改名共用）：效应里的 link 条目、pre 与效应过滤里的 $link 键换新名。 */
function retargetActionRefs(act: ActionDef, oldLink: string, newLink: string): void {
  const map = { [oldLink]: newLink };
  walkEffectItems(act, {
    link: (n) => {
      if (n !== oldLink) return;
      const item = act.effect?.find((e) => "link" in e && e.link === n);
      if (item && "link" in item) item.link = newLink;
    },
    update: (item) => renameFilterLinks(item.filter as Record<string, unknown> | undefined, map),
    delete: (item) => renameFilterLinks(item.filter as Record<string, unknown> | undefined, map),
  });
  renameFilterLinks(act.pre as Record<string, unknown> | undefined, map);
}

function retargetConversion(cls: { actions?: Record<string, ActionDef> }, oldLink: string, newLink: string, oldTo: string, newTo: string, link: LinkType, pristine: ActionDef): void {
  const rebuilt = conversionAction(newLink, link);
  const actName = conversionActionOf(cls, oldLink) ?? conversionActionOf(cls, newLink);
  const autoOld = conversionActionName(oldTo);
  const autoNew = conversionActionName(newTo);
  cls.actions ??= {};
  if (actName && actName === autoOld) {
    if (JSON.stringify(cls.actions[actName]) === JSON.stringify(pristine)) {
      // 自动骨架原样：整条重建（动作名、引用、描述跟新时期走）
      if (autoNew !== actName) {
        if (cls.actions[autoNew]) throw new DraftReject(MSG.stageActionNameClash(autoNew));
        delete cls.actions[actName];
      }
      cls.actions[autoNew] = rebuilt;
      return;
    }
    // 人改过内容（中文名、前置、效应）：只换键名与引用，不整条覆盖——改过的字不能丢
    if (autoNew !== actName) {
      if (cls.actions[autoNew]) throw new DraftReject(MSG.stageActionNameClash(autoNew));
      cls.actions[autoNew] = cls.actions[actName];
      delete cls.actions[actName];
    }
    if (newLink !== oldLink) retargetActionRefs(cls.actions[autoNew], oldLink, newLink);
  } else if (!actName) {
    if (cls.actions[autoNew]) throw new DraftReject(MSG.stageActionNameClash(autoNew));
    cls.actions[autoNew] = rebuilt;
  } else if (newLink !== oldLink) {
    retargetActionRefs(cls.actions[actName], oldLink, newLink);
  }
}

export function editStages(state: DraftState, input: EditStagesOp): void {
  const d = state.draft;
  const cls = mustClass(d, input.object);
  const cur = classStages(d, input.object);
  if (!cur) throw new DraftReject(MSG.noClassStages(input.object));
  if (input.items.length !== cur.items.length) throw new DraftReject(MSG.stageCountMismatch(cur.items.length));
  const values = input.items.map((i) => i.value.trim());
  if (values.some((v) => !v)) throw new DraftReject(MSG.stageNameEmpty);
  if (new Set(values).size !== values.length) throw new DraftReject(MSG.stageDupNames);
  if (new Set(input.items.map((i) => whenKey(i.when))).size !== input.items.length) throw new DraftReject(MSG.stageWhenDup);

  const byWhen = new Map(input.items.map((i) => [whenKey(i.when), i.value.trim()]));
  const map: Record<string, string> = {};
  for (const old of cur.items) {
    const neu = byWhen.get(whenKey(old.when));
    if (neu && neu !== old.value) map[old.value] = neu;
  }

  const prop = cls.properties[cur.property];
  prop.derived = input.items.map((i) => ({ when: i.when, value: i.value.trim() })) as typeof prop.derived;
  // 值域随规则同步；任一条带中文名才升成 { value, label } 形状，全无中文名保持裸字符串（发布文本不添形状）
  const labeled = input.items.some((i) => i.label?.trim());
  prop.values = input.items.map((i) => {
    const v = i.value.trim();
    const label = i.label?.trim();
    return label ? { value: v, label } : labeled ? { value: v } : v;
  });

  const transitions = Object.entries(d.link_types).filter(
    ([, l]) => l.from === input.object && l.to === input.object && l.transition?.property === cur.property
  );
  for (const [ln, link] of transitions) {
    const oldFrom = String(link.transition!.from);
    const oldTo = String(link.transition!.to);
    const pristine = conversionAction(ln, link); // 此刻 transition 还是旧值：与裁决落地时同形的骨架，判「人有没有改过」的基准
    const from = map[oldFrom] ?? oldFrom;
    const to = map[oldTo] ?? oldTo;
    link.transition = { property: cur.property, from, to };
    const wantLink = `${input.object}_to_${to}`;
    const wantInv = `${input.object}_from_${from}`;
    if (link.inverse === `${input.object}_from_${oldFrom}` || link.inverse === wantInv) link.inverse = wantInv;
    let linkName = ln;
    const autoOld = `${input.object}_to_${oldTo}`;
    if (ln === autoOld && autoOld !== wantLink) {
      if (d.link_types[wantLink]) throw new DraftReject(MSG.stageLinkNameClash(wantLink));
      d.link_types[wantLink] = link;
      delete d.link_types[ln];
      renameEdgeState(state, ln, wantLink);
      linkName = wantLink;
    }
    retargetConversion(cls, ln, linkName, oldTo, to, d.link_types[linkName], pristine);
  }

  if (Object.keys(map).length) {
    for (const a of Object.values(cls.actions ?? {})) {
      rewriteStatusLiterals(a.pre as Record<string, unknown> | undefined, cur.property, map);
    }
  }
}
