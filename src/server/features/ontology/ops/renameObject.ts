// 改类名 —— 类名是配置里的键：改名把引用（关系两端、类与类结论、动作里的对象名、自动起的转化关系名）和摆位一起换过来。
// 引用改写不走 refs 拦截：改名不是断链，是跟着走；唯一拦的是新名撞已有类。

import type { ActionDef, Filter, OntologyConfig } from "../../../schema/config";
import { NAME_RE } from "../../../schema/ops";
import { walkFilter, renameFilterLinks } from "../../../schema/spec/filterSpec";
import { walkEffectItems } from "../../../schema/spec/actionSpec";
import { DraftReject, MSG } from "../../../errors";
import { renameLayoutKey, renameEdgeState } from "../canvasState";
import type { DraftState } from "../canvasPack";

export function renameObject(state: DraftState, oldName: string, newName: string): void {
  const d = state.draft;
  if (!d.object_types[oldName]) throw new DraftReject(MSG.classNotFound(oldName));
  if (!NAME_RE.test(newName)) throw new DraftReject(MSG.classNameBad(newName));
  if (d.object_types[newName]) throw new DraftReject(MSG.classExists(newName));
  d.object_types[newName] = d.object_types[oldName];
  delete d.object_types[oldName];
  const renamedLinks: [string, string][] = [];
  for (const [linkName, link] of Object.entries(d.link_types)) {
    if (link.from === oldName) link.from = newName;
    if (link.to === oldName) link.to = newName;
    if (link.transition && link.from === newName && link.to === newName) {
      const to = String(link.transition.to);
      const from = String(link.transition.from);
      const auto = `${oldName}_to_${to}`;
      const autoInv = `${oldName}_from_${from}`;
      if (linkName === auto) renamedLinks.push([linkName, `${newName}_to_${to}`]);
      if (link.inverse === autoInv) link.inverse = `${newName}_from_${from}`;
    }
  }
  for (const [from, to] of renamedLinks) {
    if (d.link_types[to]) throw new DraftReject(MSG.linkExists(to));
    d.link_types[to] = d.link_types[from];
    delete d.link_types[from];
    renameEdgeState(state, from, to);
  }
  const linkMap = Object.fromEntries(renamedLinks);
  for (const [clsName, cls] of Object.entries(d.object_types)) {
    for (const act of Object.values(cls.actions ?? {})) rewriteActionClass(d, clsName, act, oldName, newName, linkMap);
  }
  if (d.class_conclusions) {
    for (const row of d.class_conclusions) {
      row.classes = row.classes.map((n) => (n === oldName ? newName : n)).sort();
      if (row.shared === oldName) row.shared = newName;
    }
  }
  renameLayoutKey(state, oldName, newName);
}

function rewriteActionClass(d: OntologyConfig, host: string, act: ActionDef, oldName: string, newName: string, linkMap: Record<string, string>): void {
  walkEffectItems(act, {
    update: (item) => {
      if (item.object === oldName) item.object = newName;
      if (item.filter) {
        rewriteRequestObject(d, item.object, item.filter as Filter, oldName, newName);
        renameFilterLinks(item.filter as Filter, linkMap); // 效应过滤里的 $link 键跟着换（改类名后的关系改名）
      }
    },
    create: (item) => {
      if (item.object === oldName) item.object = newName;
    },
    delete: (item) => {
      if (item.object === oldName) item.object = newName;
      if (item.filter) {
        rewriteRequestObject(d, item.object, item.filter as Filter, oldName, newName);
        renameFilterLinks(item.filter as Filter, linkMap);
      }
    },
    link: (name) => {
      if (linkMap[name]) {
        const item = act.effect?.find((e) => "link" in e && e.link === name);
        if (item && "link" in item) item.link = linkMap[name];
      }
    },
  });
  for (const inf of act.inform ?? []) if (inf.object === oldName) inf.object = newName;
  if (act.pre) rewriteRequestObject(d, host, act.pre as Filter, oldName, newName);
  renameFilterLinks(act.pre as Filter | undefined, linkMap);
}

function rewriteRequestObject(d: OntologyConfig, cls: string, filter: Filter, oldName: string, newName: string): void {
  walkFilter(d, cls, filter, {
    special: (_c, k, v) => {
      if (k !== "$request" || !v || typeof v !== "object") return;
      for (const cv of Object.values(v as Record<string, unknown>)) {
        if (cv && typeof cv === "object" && !Array.isArray(cv) && (cv as Record<string, unknown>).object === oldName) {
          (cv as Record<string, unknown>).object = newName;
        }
      }
    },
  });
}
