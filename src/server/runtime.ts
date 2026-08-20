// 运行态 —— 平台进程级状态的唯一构造点。
// 三份内存态（元库、驱动注册表、配置存储）挂同一个对象，globalThis 只挂这一个键：
// Next dev 下各路由包各有模块实例，挂全局才共享同一份；测试 installRuntime(makeRuntime({ cwd: tmp }))
// 整套换掉——不再 chdir，也不再逐个 reset。cwd 与 ONTOS_META_DSN 只在 makeRuntime 读一次。
// 单进程假设写在这里：已发布/工作副本是进程内缓存，多实例部署不会互见。

import type { MetaStore } from "./meta/store";
import type { DriverRegistry } from "./engine/registry";
import type { Store as ConfigStore } from "./engine/configStore";

export interface OntosRuntime {
  cwd: string;
  metaDsn?: string;
  meta?: MetaStore;
  registries?: Map<string, DriverRegistry>;
  stores?: Map<string, ConfigStore>;
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
