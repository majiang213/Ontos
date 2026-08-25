// 引擎依赖 —— 边界（路由 / MCP）组装一次后显式下传，引擎不摸全局单例（runtime / metaStore / getSlot）。
// Maps（stores / tails / actionTails）由全局组合根持有（Next dev 各路由包模块实例不共享模块级状态，
// 串行化承诺靠它们挂全局），这里只收句柄；clock / uuid 是引擎唯一的时钟与随机来源。

import type { MetaStore } from "../meta/store";
import type { DriverRegistry } from "../infra/registry";
import type { Store } from "./ontology/current";
import type { LlmSlot } from "../infra/llm/slot";

export interface EngineEnv {
  /** 平台元库（版本链、工作行、连接、裁决留痕、日志、发号器）。 */
  meta: MetaStore;
  /** 按空间取驱动注册表（fixture 播种与元库连接注册在 infra/connections，引擎只消费结果）。 */
  getRegistry(workspace: string): Promise<DriverRegistry>;
  /** 每工作空间一份内存态（已发布快照 + 工作副本）。 */
  stores: Map<string, Store>;
  /** 每空间一条草稿写队列（editDraft / publish / discard / rollbackTo）。 */
  tails: Map<string, Promise<void>>;
  /** 每空间一条动作串行队列（runAction：发号与 create 幂等的互斥）。 */
  actionTails: Map<string, Promise<void>>;
  /** LLM 槽位（离线回退或真模型）。 */
  llm: LlmSlot;
  /** 此刻（UTC Unix 秒）：日期表达式与留痕时长的唯一时间源。 */
  clock: () => number;
  /** uuid v7：generate 的 { uuid: v7 } 唯一随机源。 */
  uuid: () => string;
}
