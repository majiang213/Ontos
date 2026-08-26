// 测试运行态辅助：每个用例一个临时目录 + 一个全新 Runtime（src/server/runtime.ts）。
// 不再 chdir：cwd 由运行态携带；不再逐个 reset 单例：installRuntime 整套换掉并关掉旧句柄。
// 引擎依赖（EngineEnv）由 engineEnv() 组装——与生产路由同一条组装点，测试直接取用。

import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect } from "vitest";
import { engineEnv, installRuntime, makeRuntime, type OntosRuntime } from "@/server/runtime";
import type { EngineEnv } from "@/server/features/env";
import type { Result } from "@/server/errors";

/** 成功路径取 value：断言 code=200 并返回 value（测试少写样板；契约仍被断言，失败即红）。 */
export function unwrap<T>(r: Result<T>): T {
  expect(r.code).toBe(200);
  return (r as { code: 200; value: T }).value;
}

/** 失败路径断言：code 非 200（可指定具体码），message 可匹配。 */
export async function expectRejected<T>(p: Promise<Result<T>>, match?: string | RegExp, code?: number): Promise<void> {
  const r = await p;
  expect(r.code).not.toBe(200);
  if (code !== undefined) expect(r.code).toBe(code);
  if (match !== undefined) expect(r.message).toMatch(match);
}

/** 建临时目录、拷种子配置、装一个 cwd 指向它的全新运行态。返回临时目录路径。
 *  overrides 可注入 clock / uuid 等（确定性测试钉死时间与随机源）。 */
export async function setupRuntime(prefix: string, overrides: Partial<OntosRuntime> = {}): Promise<string> {
  const tmp = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(tmp, "src/server/config"), { recursive: true });
  cpSync(join(process.cwd(), "src/server/config/ontology.yaml"), join(tmp, "src/server/config/ontology.yaml"));
  await installRuntime(makeRuntime({ cwd: tmp, ...overrides }));
  return tmp;
}

/** 模拟进程重启：内存态（已发布快照/工作副本/注册表/元库句柄）整套换掉，临时目录不动。 */
export async function restartRuntime(tmp: string): Promise<void> {
  await installRuntime(makeRuntime({ cwd: tmp }));
}

/** 回默认运行态（顺带关掉临时目录上的元库句柄与驱动），再删目录。 */
export async function cleanupRuntime(tmp: string): Promise<void> {
  await installRuntime(makeRuntime());
  rmSync(tmp, { recursive: true, force: true });
}

/** 当前运行态的引擎依赖（与生产路由同一条组装点 engineEnv；先 setupRuntime 再取）。 */
export function testEnv(): EngineEnv {
  return engineEnv();
}

/** 草稿链的测试门面：受理 + 当前两份 + 版本链三个模块合并成一份命名空间（s.editDraft / s.getRev / s.publish …）。
 *  生产代码不走这种合并口——直插具体模块，依赖方向保持可见；测试要的是「整条链在手」。
 *  依赖对象每次调用现组装（engineEnv，与生产路由同一条组装点）：installRuntime 换运行态后
 *  后续调用自动用新一套——重启路径的测试（模拟进程重启）依赖这一点。 */
export async function draftEngine() {
  const editDraft = await import("../server/features/ontology/editDraft");
  const current = await import("../server/features/ontology/current");
  const versions = await import("../server/features/ontology/versions");
  const sameConfig = await import("../server/features/ontology/sameConfig");
  return {
    /** 当前运行态的引擎依赖（getter：每次取现组装）。 */
    get env() {
      return engineEnv();
    },
    editDraft: (op: Parameters<typeof editDraft.editDraft>[1], workspace?: string, opts?: { base_rev?: number }) => editDraft.editDraft(engineEnv(), op, workspace, opts),
    mutateDraft: (fn: Parameters<typeof editDraft.mutateDraft>[1], workspace?: string) => editDraft.mutateDraft(engineEnv(), fn, workspace),
    getDraft: (workspace?: string) => current.getDraft(engineEnv(), workspace),
    getPublished: (workspace?: string) => current.getPublished(engineEnv(), workspace),
    getRev: (workspace?: string) => current.getRev(engineEnv(), workspace),
    publish: (workspace?: string) => versions.publish(engineEnv(), workspace),
    discard: (workspace?: string) => versions.discard(engineEnv(), workspace),
    listVersions: (workspace?: string) => versions.listVersions(engineEnv(), workspace),
    rollbackTo: (version: number, workspace?: string) => versions.rollbackTo(engineEnv(), version, workspace),
    ...sameConfig,
  };
}

/** 重启运行态后取草稿链测试门面：每用例一份干净内存态（draft 的 Store 是运行态携带的单例，重启后 import 到的就是它）。 */
export async function freshStore(tmp: string) {
  await restartRuntime(tmp);
  return draftEngine();
}

/** 当前运行态的元库门面（配合 freshStore 用：重启由 freshStore 管）。 */
export async function meta() {
  return (await import("../server/meta/store")).metaStore();
}
