// 关系变动 —— 不变量：引用不断链（被动作/派生引用的关系拒删拒改）；配对字段跟端点走（改接时还存在的留、
// 留不下的用两边唯一键或首个属性重配）；转化关系不改接不配配对；界面状态跟随（钉点随车、改名搬迁）。
// create_link / delete_link / update_link 三条 op 住这里。

import type { OntologyConfig } from "../../../schema/config";
import { NAME_RE, type DraftOpInput as DraftOp } from "../../../schema/ops";
import { DraftReject, MSG } from "../../../errors";
import { linkRefs } from "../refs";
import { definedPinEnds, mergeEdgePins, renameEdgeState, setEdgePins } from "../canvasState";
import type { DraftState } from "../canvasPack";
import { mustType } from "./subjectClass";

type CreateLinkOp = Extract<DraftOp, { op: "create_link" }>;
type DeleteLinkOp = Extract<DraftOp, { op: "delete_link" }>;
type UpdateLinkOp = Extract<DraftOp, { op: "update_link" }>;

export function createLink(state: DraftState, input: CreateLinkOp): void {
  const d = state.draft;
  if (!NAME_RE.test(input.name)) throw new DraftReject(MSG.linkNameBad);
  if (d.link_types[input.name]) throw new DraftReject(MSG.linkExists(input.name));
  mustType(d, input.from);
  mustType(d, input.to);
  if (!d.object_types[input.from].properties[input.match.from]) throw new DraftReject(MSG.propNotOnClass(input.from, input.match.from));
  if (!d.object_types[input.to].properties[input.match.to]) throw new DraftReject(MSG.propNotOnClass(input.to, input.match.to));
  if (input.inverse && !NAME_RE.test(input.inverse)) throw new DraftReject(MSG.linkInverseBad);
  d.link_types[input.name] = {
    from: input.from,
    to: input.to,
    inverse: input.inverse || undefined,
    card: input.card,
    description: input.description,
    match: [{ from: input.match.from, to: input.match.to }], // 手动关系只说配对字段；转化关系由裁决产生
  };
  // 钉点随车（界面状态）：建线一把落库，不再有 save_edge_pin 接力
  const pins = definedPinEnds(input.pins);
  if (pins) setEdgePins(state, input.name, pins);
}

export function deleteLink(d: OntologyConfig, input: DeleteLinkOp): void {
  if (!d.link_types[input.name]) throw new DraftReject(MSG.linkNotFound(input.name));
  const refs = linkRefs(d, input.name);
  if (refs.length) throw new DraftReject(MSG.stillReferenced(input.name, refs));
  delete d.link_types[input.name]; // 死弯折/钉点由事务收尾清
}

export function updateLink(state: DraftState, input: UpdateLinkOp): void {
  const d = state.draft;
  const l = d.link_types[input.name];
  if (!l) throw new DraftReject(MSG.linkNotFound(input.name));
  if (input.from !== undefined || input.to !== undefined) {
    // 画布拖边改接：先全部校验再落笔，配对字段跟着新端点修——还存在的留，留不下的用两边唯一键（或首个属性）重配
    const from = input.from ?? l.from;
    const to = input.to ?? l.to;
    if (l.transition) throw new DraftReject(MSG.transitionNoRewire);
    if (from === to) throw new DraftReject(MSG.linkSameEnds);
    const refs = linkRefs(d, input.name); // 改端点与改名同理：引用它的动作按 from/to 走线，会静默断
    if (refs.length) throw new DraftReject(MSG.linkStillReferencedRewire(input.name, refs));
    const fromT = mustType(d, from);
    const toT = mustType(d, to);
    let match = l.match;
    if (match) {
      match = match.filter((m) => fromT.properties[m.from] && toT.properties[m.to]);
      if (!match.length) {
        const f = fromT.identity ?? Object.keys(fromT.properties)[0];
        const t = toT.identity ?? Object.keys(toT.properties)[0];
        if (!f || !t) throw new DraftReject(MSG.linkNoPairProps);
        match = [{ from: f, to: t }];
      }
    }
    l.from = from;
    l.to = to;
    if (match) l.match = match;
  }
  if (input.match !== undefined) {
    // 改配对字段：与改两端同闸——转化关系没有配对、被引用的关系改了会静默变语义
    if (l.transition) throw new DraftReject(MSG.transitionNoRematch);
    const refs = linkRefs(d, input.name);
    if (refs.length) throw new DraftReject(MSG.linkStillReferencedRematch(input.name, refs));
    if (!d.object_types[l.from].properties[input.match.from]) throw new DraftReject(MSG.propNotOnClass(l.from, input.match.from));
    if (!d.object_types[l.to].properties[input.match.to]) throw new DraftReject(MSG.propNotOnClass(l.to, input.match.to));
    l.match = [{ from: input.match.from, to: input.match.to }];
  }
  if (input.description !== undefined) l.description = input.description || undefined; // 空串 = 清掉
  if (input.inverse !== undefined) {
    if (input.inverse && !NAME_RE.test(input.inverse)) throw new DraftReject(MSG.linkInverseBad);
    l.inverse = input.inverse || undefined; // 空串 = 清掉
  }
  if (input.new_name && input.new_name !== input.name) {
    if (!NAME_RE.test(input.new_name)) throw new DraftReject(MSG.linkNameBad);
    if (d.link_types[input.new_name]) throw new DraftReject(MSG.linkExists(input.new_name));
    const refs = linkRefs(d, input.name); // 改名即引用断链——被动作/派生引用的关系拒改
    if (refs.length) throw new DraftReject(MSG.linkStillReferencedRename(input.name, refs));
    d.link_types[input.new_name] = l;
    delete d.link_types[input.name];
    renameEdgeState(state, input.name, input.new_name); // 界面状态跟边改名走（边以关系名为键）：不跟就成孤儿，改名即丢
  }
  // 钉点随车（界面状态）：按端合并进既有钉点；改名了的写在新名下
  const pins = definedPinEnds(input.pins);
  if (pins) {
    const finalName = input.new_name && input.new_name !== input.name ? input.new_name : input.name;
    mergeEdgePins(state, finalName, pins);
  }
}
