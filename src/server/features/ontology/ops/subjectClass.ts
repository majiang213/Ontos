// 被编辑的类必须存在 —— 编辑 op 的共用断言：op 谈的类不在就 DraftReject。

import type { OntologyConfig } from "../../../schema/config";
import { DraftReject, MSG } from "../../../errors";

export function mustType(d: OntologyConfig, name: string) {
  const t = d.object_types[name];
  if (!t) throw new DraftReject(MSG.classNotFound(name));
  return t;
}
