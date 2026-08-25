// 血缘反查：列 → 本体属性（sources 映射的倒置计算）。与 refs.ts 的正向引用扫描同一家。
// 纯函数零运行期依赖（type-only import）：画布表结构抽屉直接引用（同 valueSpec 的共享方式），不经接口转发。

import type { OntologyConfig } from "../../schema/config";

/** 列的映射去向：命中字段映射给「类.属性（源条目）」，命中主键给「类 的主键（源条目）」，都没有是「未映射」。 */
export function columnTarget(config: Pick<OntologyConfig, "object_types">, connection: string, table: string, column: string): string {
  for (const [clsName, t] of Object.entries(config.object_types)) {
    for (const [srcName, s] of Object.entries(t.sources ?? {})) {
      if (s.connection !== connection || s.table !== table) continue;
      for (const [prop, col] of Object.entries(s.fields)) {
        if (col === column) return `${clsName}.${prop}（${srcName}）`;
      }
      if (s.pk === column) return `${clsName} 的主键（${srcName}）`;
    }
  }
  return "未映射";
}
