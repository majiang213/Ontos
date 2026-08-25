// 撤类 —— 「撤一个类，连同挂着它的关系」：delete_object 与裁决的 mergeInto 共用这一个函数。

import type { OntologyConfig } from "../../../schema/config";
import { DraftReject, MSG } from "../../../errors";

/** 撤一个类，连同挂着它的关系（delete_object 与裁决的 mergeInto 共用）。 */
export function dropClass(d: OntologyConfig, name: string): void {
  delete d.object_types[name];
  for (const [linkName, link] of Object.entries(d.link_types)) {
    if (link.from === name || link.to === name) delete d.link_types[linkName];
  }
}

/** delete_object：类不存在则拒；撤类连带撤关系（死摆位由事务收尾清）。 */
export function deleteObject(d: OntologyConfig, input: { name: string }): void {
  if (!d.object_types[input.name]) throw new DraftReject(MSG.classNotFound(input.name));
  dropClass(d, input.name);
}
