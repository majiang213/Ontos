// op 分派 —— 16 条草稿编辑 op 的唯一解释入口（REST 画布与 MCP edit_draft 同走这里）：只做内存修改。
// 浅 case（没有跨键不变量：单点赋值 + 存在性/格式检查）留本文件；厚不变量各自成文件——
// 撤类连带 editObject、删/改名字段跟随 editProperty、关系变动 editLink、整批原子 importObjects、整份替换锁定 replaceObject。
// 落库、校验、rev、dirty 全由 editDraft 决定；界面状态三键的写一律走 canvasState 原语。

import type { OntologyConfig } from "../../../schema/config";
import { NAME_RE, type DraftOpInput as DraftOp } from "../../../schema/ops";
import { DraftReject, MSG } from "../../../errors";
import { setEdgeBend, setLayout } from "../canvasState";
import type { DraftState } from "../canvasPack";
import { deleteObject } from "./editObject";
import { removeProperty, updateProperty } from "./editProperty";
import { createLink, deleteLink, updateLink } from "./editLink";
import { importObjects } from "./importObjects";
import { replaceObject } from "./replaceObject";
import { mustType } from "./mustType";

/** 解释一个 op：只改内存（state.draft 与界面状态三键）。落库、校验、rev、dirty 全由 editDraft 决定。 */
export function applyOp(state: DraftState, input: DraftOp, published: OntologyConfig): void {
  const d = state.draft;
  switch (input.op) {
    case "create_object": {
      if (!NAME_RE.test(input.name)) throw new DraftReject(MSG.classNameBad);
      if (d.object_types[input.name]) throw new DraftReject(MSG.classExists(input.name));
      d.object_types[input.name] = { kind: input.kind, description: input.description, properties: {} }; // 无源对象进 manual 桶
      break;
    }
    case "delete_object":
      deleteObject(d, input);
      break;
    case "update_object": {
      const t = mustType(d, input.name);
      if (input.description !== undefined) t.description = input.description;
      break;
    }
    case "add_property": {
      const t = mustType(d, input.object);
      if (!NAME_RE.test(input.name)) throw new DraftReject(MSG.propNameBad);
      if (t.properties[input.name]) throw new DraftReject(MSG.propExists(input.name));
      t.properties[input.name] = { type: input.type, description: input.description, values: input.values };
      break;
    }
    case "remove_property":
      removeProperty(d, input);
      break;
    case "update_property":
      updateProperty(d, input);
      break;
    case "set_identity": {
      const t = mustType(d, input.object);
      if (input.name === "") {
        delete t.identity; // 取消识别字段
        break;
      }
      if (!t.properties[input.name]) throw new DraftReject(MSG.propNotFound(input.name));
      if (t.properties[input.name].derived) throw new DraftReject(MSG.propDerivedNoIdentity);
      t.identity = input.name;
      break;
    }
    case "save_layout":
      setLayout(state, input.positions); // 摆位只进内存；落库在 editDraft 的界面状态分流
      break;
    case "save_edge_bend": {
      if (!state.draft.link_types[input.name]) throw new DraftReject(MSG.linkNotFound(input.name));
      setEdgeBend(state, input.name, input.bend); // null = 拉直
      break;
    }
    case "create_link":
      createLink(state, input);
      break;
    case "delete_link":
      deleteLink(d, input);
      break;
    case "update_link":
      updateLink(state, input);
      break;
    case "import_objects":
      importObjects(d, input);
      break;
    case "replace_object":
      replaceObject(d, input, published);
      break;
    case "set_action": {
      // 单条 upsert：同名覆盖、不同名新增。def 已在 schema 层过 actionSchema；形状四查在 validateActionShapes
      const t = d.object_types[input.object];
      if (!t) throw new DraftReject(MSG.classNotFoundImport(input.object));
      t.actions ??= {};
      t.actions[input.name] = input.def;
      break;
    }
    case "remove_action": {
      const t = mustType(d, input.object);
      if (!t.actions?.[input.name]) throw new DraftReject(MSG.actionNotFound(input.name));
      delete t.actions[input.name];
      if (Object.keys(t.actions).length === 0) delete t.actions; // 空 map 会让 sameConfig 的 dirty 收不回来，删干净
      break;
    }
    default:
      throw new DraftReject(MSG.unknownOp(input));
  }
}
