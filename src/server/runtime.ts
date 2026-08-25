// 运行态 —— 平台进程级状态的唯一构造点。
// 三份内存态（元库、驱动注册表、工作副本存储）挂同一个对象，globalThis 只挂这一个键：
// Next dev 下各路由包各有模块实例，挂全局才共享同一份；测试 installRuntime(makeRuntime({ cwd: tmp }))
// 整套换掉——不再 chdir，也不再逐个 reset。cwd 与 ONTOS_META_DSN 只在 makeRuntime 读一次。
// 单进程假设写在这里：已发布快照与工作副本的热缓存挂在进程里；编辑写入
// onto_version 的工作行（version IS NULL 行的 canvas_json，不是 YAML），重启从库读回。YAML 只在发布时进 onto_version 的编号行。
// 多实例部署各有缓存，不会互见。
// engineEnv() 是引擎依赖的组装点（边界经它显式下传）：Maps 仍由本文件持有；clock / uuid 默认真实实现、
// 测试经 makeRuntime 覆盖注入；LLM 槽位选择（离线回退 / 真模型）也收在这里——引擎不再自查任何单例。

import { createXai } from "@ai-sdk/xai";
import type { MetaStore } from "./meta/store";
import { metaStore } from "./meta/store";
import type { DriverRegistry } from "./infra/registry";
import { getDriverRegistry } from "./infra/connections";
import type { Store as DraftStore } from "./features/ontology/current";
import { CannedSlot } from "./infra/llm/canned";
import { AiSdkSlot } from "./infra/llm/aiSdk";
import type { LlmSlot } from "./infra/llm/slot";
import type { EngineEnv } from "./features/env";
import { MSG } from "./errors";

export interface OntosRuntime {
  cwd: string;
  metaDsn?: string;
  meta?: MetaStore;
  registries?: Map<string, DriverRegistry>;
  stores?: Map<string, DraftStore>;
  llmSlot?: LlmSlot;
  /** 每空间一条写队列（draft/current.enqueue）：与它保护的 stores 挂同一层——
   *  挂模块级会在 Next dev 多路由包下各持一条，串行化承诺恰好失效；installRuntime 整套换掉才真隔离。 */
  tails?: Map<string, Promise<void>>;
  /** 每空间一条动作串行队列（runAction）：发号（generate sequence）与 create 幂等都是 check-then-act，
   *  没有串行化，两个并发动作会发出重号、补偿重发会插重复行。 */
  actionTails?: Map<string, Promise<void>>;
  /** 测试注入假时钟（UTC Unix 秒）；缺省真实系统时间（引擎读不到系统时间，只有这一处实现）。 */
  clock?: () => number;
  /** 测试注入假 uuid 源；缺省真实 v7（引擎不碰 crypto，只有这一处实现）。 */
  uuid?: () => string;
}

/** 真实时钟：UTC Unix 秒。 */
const realClock = (): number => Math.floor(Date.now() / 1000);

/** 真实 uuid v7：48 位毫秒时间戳 + 版本/变体位 + 10 字节随机。 */
function realUuidV7(): string {
  const ms = Date.now(); // 48 位毫秒时间戳
  const rnd = crypto.getRandomValues(new Uint8Array(10));
  const b = [
    (ms / 2 ** 40) & 0xff, (ms / 2 ** 32) & 0xff, (ms / 2 ** 24) & 0xff,
    (ms / 2 ** 16) & 0xff, (ms / 2 ** 8) & 0xff, ms & 0xff,
    0x70 | (rnd[0] & 0x0f), rnd[1], // version 7
    0x80 | (rnd[2] & 0x3f), rnd[3], // variant 10
    rnd[4], rnd[5], rnd[6], rnd[7], rnd[8], rnd[9],
  ];
  const h = [...b].map((x) => Math.floor(x).toString(16).padStart(2, "0"));
  return `${h.slice(0, 4).join("")}-${h.slice(4, 6).join("")}-${h.slice(6, 8).join("")}-${h.slice(8, 10).join("")}-${h.slice(10, 16).join("")}`;
}

/** 槽位选择：有 OPENAI_API_KEY 走真模型（OpenAI 兼容协议，通用键同 Claude Code / Codex），实例缓存在运行态上；
 *  否则离线回退（CannedSlot：问数只覆盖演示剧本，逆向建模与候选对建议是通用启发式，各空间都能用）。
 *  模型必须显式指定 OPENAI_MODEL，不设默认；接入点用 OPENAI_BASE_URL，不设走 SDK 默认端点。 */
export function getSlot(): LlmSlot {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return new CannedSlot();
  const rt = runtime();
  if (!rt.llmSlot) {
    const model = process.env.OPENAI_MODEL;
    if (!model) throw new Error(MSG.openaiModelMissing);
    const xai = createXai({ apiKey: key, baseURL: process.env.OPENAI_BASE_URL ?? undefined });
    rt.llmSlot = new AiSdkSlot(xai.responses(model));
  }
  return rt.llmSlot;
}

/** 缺省取进程cwd与 ONTOS_META_DSN；测试传 { cwd: 临时目录 }（另可注入 clock / uuid 钉死时间与随机）。 */
export function makeRuntime(overrides: Partial<OntosRuntime> = {}): OntosRuntime {
  return { cwd: process.cwd(), metaDsn: process.env.ONTOS_META_DSN, ...overrides };
}

const g = globalThis as unknown as { __ontosRuntime?: OntosRuntime };

export function runtime(): OntosRuntime {
  return (g.__ontosRuntime ??= makeRuntime());
}

/** 引擎依赖组装（边界入口）：路由 / MCP 构造一次，随调用显式下传。
 *  Maps 从全局组合根取（跨模块实例共享，串行化承诺不破）；clock / uuid 缺省真实实现。 */
export function engineEnv(): EngineEnv {
  const rt = runtime();
  return {
    meta: metaStore(),
    getRegistry: (workspace) => getDriverRegistry(workspace),
    stores: (rt.stores ??= new Map()),
    tails: (rt.tails ??= new Map()),
    actionTails: (rt.actionTails ??= new Map()),
    llm: getSlot(),
    clock: rt.clock ?? realClock,
    uuid: rt.uuid ?? realUuidV7,
  };
}

/** 换整套运行态：先把旧运行态的元库句柄与驱动关掉再挂新的。 */
export async function installRuntime(rt: OntosRuntime): Promise<void> {
  const prev = g.__ontosRuntime;
  g.__ontosRuntime = rt;
  if (!prev) return;
  if (prev.meta) await prev.meta.close();
  if (prev.registries) for (const r of prev.registries.values()) for (const name of r.connectionNames()) r.unregister(name);
}
