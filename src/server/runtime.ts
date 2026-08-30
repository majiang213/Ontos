// 运行态 —— 平台进程级状态的唯一构造点。
// 无状态化之后，这里只剩两类进程本地物：元库/驱动注册表/LLM 实现句柄（可重建的实例本地缓存）与
// clock / uuid / 雪花号等注入源。globalThis 只挂这一个键：Next dev 下各路由包各有模块实例，挂全局才共享同一份；
// 测试 installRuntime(makeRuntime({ cwd: tmp })) 整套换掉——不再 chdir，也不再逐个 reset。
// 多实例语义：已发布快照与工作副本全部读库（onto_version），写走 rev CAS——同一份元库下任意多个实例行为一致；
// 多实例部署要求 ONTOS_META_DSN=mysql:// 或 postgres://（SQLite 单文件保留本地开发/单实例/全部测试）。
// engineEnv() 是引擎依赖的组装点（边界经它显式下传）：clock / uuid / snowflake 默认真实实现、
// 测试经 makeRuntime 覆盖注入（含固定 instanceId 钉死雪花）；LLM 实现选择（真模型 / 演示实现，按 Key 与空间）也收在这里。

import { createXai } from "@ai-sdk/xai";
import type { MetaStore } from "./meta/store";
import { metaStore } from "./meta/store";
import type { DriverRegistry } from "./infra/registry";
import { getDriverRegistry } from "./infra/connections";
import { makeSnowflake } from "./infra/snowflake";
import { DemoLlm } from "./infra/llm/demo";
import { AiSdkLlm } from "./infra/llm/aiSdk";
import type { Llm } from "./infra/llm/llm";
import { TEST_WORKSPACE } from "./infra/workspace";
import type { EngineEnv } from "./features/env";
import { EngineReject, MSG } from "./errors";

export interface OntosRuntime {
  cwd: string;
  metaDsn?: string;
  meta?: MetaStore;
  registries?: Map<string, DriverRegistry>;
  llmAiSdk?: Llm;
  llmDemo?: Llm;
  /** 测试注入假时钟（UTC Unix 秒）；缺省真实系统时间（引擎读不到系统时间，只有这一处实现）。 */
  clock?: () => number;
  /** 测试注入假 uuid 源；缺省真实 v7（引擎不碰 crypto，只有这一处实现）。 */
  uuid?: () => string;
  /** 测试注入固定雪花实例 id（0–1023）；缺省 ONTOS_SNOWFLAKE_INSTANCE_ID 或随机派生。 */
  instanceId?: number;
  /** 测试注入假雪花号源；缺省按 clock + instanceId 组真实雪花（闭包缓存在运行态：每实例一个，跨请求递增不撞号）。 */
  snowflake?: () => string;
  /** 真实雪花的闭包缓存（进程本地状态）：同毫秒跨请求靠它递增序列。 */
  snowflakeFn?: () => string;
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

/** 雪花实例 id：ONTOS_SNOWFLAKE_INSTANCE_ID（0–1023）优先；未分配时随机——部署必须分配，随机碰撞概率极低但存在。 */
function instanceIdOf(rt: OntosRuntime): number {
  if (rt.instanceId !== undefined) return rt.instanceId & 0x3ff;
  const fromEnv = Number(process.env.ONTOS_SNOWFLAKE_INSTANCE_ID);
  if (Number.isInteger(fromEnv) && fromEnv >= 0 && fromEnv <= 1023) return fromEnv;
  return Math.floor(Math.random() * 1024);
}

/** LLM 实现选择：有 OPENAI_API_KEY 走真模型 AiSdkLlm（OpenAI 兼容协议，通用键同 Claude Code / Codex），所有空间一致；
 *  没 Key 时 test 空间走演示实现 DemoLlm（问数剧本 + 逆向建模/倾向的确定性规则），其他空间直接报错——
 *  演示行为按工作空间绑定，不按 Key；演示剧本只属于 test。实例缓存在运行态上。
 *  模型必须显式指定 OPENAI_MODEL，不设默认；接入点用 OPENAI_BASE_URL（填基址，SDK 自己拼 /chat/completions），
 *  不设走 SDK 默认端点。走 chat completions 而非 Responses API：OpenAI 兼容网关普遍只实现前者（后者会 404）。 */
export function getLlm(workspace: string): Llm {
  const key = process.env.OPENAI_API_KEY;
  const rt = runtime();
  if (!key) {
    if (workspace !== TEST_WORKSPACE) throw new EngineReject(MSG.llmKeyRequired(workspace));
    rt.llmDemo ??= new DemoLlm();
    return rt.llmDemo;
  }
  if (rt.llmAiSdk && (typeof rt.llmAiSdk.proposePair !== "function" || typeof rt.llmAiSdk.proposeKey !== "function")) rt.llmAiSdk = undefined; // 热更留下的旧实例没有新方法，丢掉重做
  if (!rt.llmAiSdk) {
    const model = process.env.OPENAI_MODEL;
    if (!model) throw new Error(MSG.openaiModelMissing);
    const xai = createXai({ apiKey: key, baseURL: process.env.OPENAI_BASE_URL ?? undefined });
    rt.llmAiSdk = new AiSdkLlm(xai.chat(model));
  }
  return rt.llmAiSdk;
}

/** 缺省取进程cwd与 ONTOS_META_DSN；测试传 { cwd: 临时目录 }（另可注入 clock / uuid / instanceId / snowflake 钉死时间、随机与发号）。 */
export function makeRuntime(overrides: Partial<OntosRuntime> = {}): OntosRuntime {
  return { cwd: process.cwd(), metaDsn: process.env.ONTOS_META_DSN, ...overrides };
}

const g = globalThis as unknown as { __ontosRuntime?: OntosRuntime };

export function runtime(): OntosRuntime {
  return (g.__ontosRuntime ??= makeRuntime());
}

/** 引擎依赖组装（边界入口）：路由 / MCP 构造一次，随调用显式下传；clock / uuid / snowflake 缺省真实实现。 */
export function engineEnv(): EngineEnv {
  const rt = runtime();
  const clock = rt.clock ?? realClock;
  return {
    meta: metaStore(),
    getRegistry: (workspace) => getDriverRegistry(workspace),
    llm: (workspace) => getLlm(workspace),
    clock,
    uuid: rt.uuid ?? realUuidV7,
    snowflake: rt.snowflake ?? (rt.snowflakeFn ??= makeSnowflake(clock, instanceIdOf(rt))),
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
