// 运行态 —— 平台进程级状态的唯一构造点。
// 三份内存态（元库、驱动注册表、工作副本存储）挂同一个对象，globalThis 只挂这一个键：
// Next dev 下各路由包各有模块实例，挂全局才共享同一份；测试 installRuntime(makeRuntime({ cwd: tmp }))
// 整套换掉——不再 chdir，也不再逐个 reset。cwd 与 ONTOS_META_DSN 只在 makeRuntime 读一次。
// 单进程假设写在这里：已发布快照与工作副本的热缓存挂在进程里；编辑写入
// onto_version 的工作行（version IS NULL 行的 canvas_json，不是 YAML），重启从库读回。YAML 只在发布时进 onto_version 的编号行。
// 多实例部署各有缓存，不会互见。

import type { MetaStore } from "./meta/store";
import type { DriverRegistry } from "./engine/infra/registry";
import type { Store as DraftStore } from "./engine/draft/current";
import type { LlmSlot } from "./engine/llmSlot";

export interface OntosRuntime {
  cwd: string;
  metaDsn?: string;
  meta?: MetaStore;
  registries?: Map<string, DriverRegistry>;
  stores?: Map<string, DraftStore>;
  llmSlot?: LlmSlot;
  /** 每工作空间一条写队列（draft/current.enqueue）：与它保护的 stores 挂同一层——
   *  挂模块级会在 Next dev 多路由包下各持一条，串行化承诺恰好失效；installRuntime 整套换掉才真隔离。 */
  tails?: Map<string, Promise<void>>;
  /** 每空间一条动作串行队列（runAction）：发号（generate sequence）与 create 幂等都是 check-then-act，
   *  没有串行化，两个并发动作会发出重号、补偿重发会插重复行。 */
  actionTails?: Map<string, Promise<void>>;
}

/** 键控串行队列（draft 写入的 tails 与 runAction 的 actionTails 同款，一处维护）：
 *  prev 失败也续链（前一次拒绝不拖死后续）；拒绝仍传给调用方。 */
export function enqueueKeyed<T>(map: Map<string, Promise<void>>, key: string, task: () => Promise<T>): Promise<T> {
  const prev = map.get(key) ?? Promise.resolve();
  const run = prev.then(task, task); // 前一次拒绝也跑这一次
  map.set(key, run.then(() => undefined, () => undefined)); // 只续链，吞掉结果；拒绝仍传给调用方
  return run;
}

/** 缺省取进程cwd与 ONTOS_META_DSN；测试传 { cwd: 临时目录 }。 */
export function makeRuntime(overrides: Partial<OntosRuntime> = {}): OntosRuntime {
  return { cwd: process.cwd(), metaDsn: process.env.ONTOS_META_DSN, ...overrides };
}

const g = globalThis as unknown as { __ontosRuntime?: OntosRuntime };

export function runtime(): OntosRuntime {
  return (g.__ontosRuntime ??= makeRuntime());
}

/** 换整套运行态：先把旧运行态的元库句柄与驱动关掉再挂新的。 */
export async function installRuntime(rt: OntosRuntime): Promise<void> {
  const prev = g.__ontosRuntime;
  g.__ontosRuntime = rt;
  if (!prev) return;
  if (prev.meta) await prev.meta.close();
  if (prev.registries) for (const r of prev.registries.values()) for (const name of r.connectionNames()) r.unregister(name);
}
