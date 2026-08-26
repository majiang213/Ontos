// 引擎依赖 —— 边界（路由 / MCP）组装一次后显式下传，引擎不摸全局单例（runtime / metaStore / getSlot）。
// 无状态：本对象不再持有任何进程内可变状态（写队列 / 内存缓存已随无状态化删除）；
// 元库句柄、驱动注册表访问、LLM 槽位、时钟、uuid、雪花号都由组合根组装，引擎只消费注入值。

import type { MetaStore } from "../meta/store";
import type { DriverRegistry } from "../infra/registry";
import type { LlmSlot } from "../infra/llm/slot";

export interface EngineEnv {
  /** 平台元库（版本链、工作行、连接、裁决留痕、日志）。 */
  meta: MetaStore;
  /** 按空间取驱动注册表（fixture 播种与元库连接注册在 infra/connections，引擎只消费结果）。 */
  getRegistry(workspace: string): Promise<DriverRegistry>;
  /** LLM 槽位（离线回退或真模型）。 */
  llm: LlmSlot;
  /** 此刻（UTC Unix 秒）：日期表达式与留痕时长的唯一时间源。 */
  clock: () => number;
  /** uuid v7：generate 的 { uuid: v7 } 唯一随机源。 */
  uuid: () => string;
  /** 雪花号：generate 的 { snowflake: true } 唯一发号源（无共享计数器，跨实例不撞号）。 */
  snowflake: () => string;
}
