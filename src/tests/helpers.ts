// 测试运行态辅助：每个用例一个临时目录 + 一个全新 Runtime（src/server/runtime.ts）。
// 不再 chdir：cwd 由运行态携带；不再逐个 reset 单例：installRuntime 整套换掉并关掉旧句柄。

import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installRuntime, makeRuntime } from "@/server/runtime";

/** 建临时目录、拷种子配置、装一个 cwd 指向它的全新运行态。返回临时目录路径。 */
export async function setupRuntime(prefix: string): Promise<string> {
  const tmp = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(tmp, "src/server/config"), { recursive: true });
  cpSync(join(process.cwd(), "src/server/config/ontology.yaml"), join(tmp, "src/server/config/ontology.yaml"));
  await installRuntime(makeRuntime({ cwd: tmp }));
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

/** 草稿链的测试门面：受理 + 当前两份 + 版本链三个模块合并成一份命名空间（s.editDraft / s.getRev / s.publish …）。
 *  生产代码不走这种合并口——直插具体模块，依赖方向保持可见；测试要的是「整条链在手」。 */
export async function draftEngine() {
  return {
    ...(await import("../server/engine/draft/editDraft")),
    ...(await import("../server/engine/draft/current")),
    ...(await import("../server/engine/draft/versions")),
    ...(await import("../server/engine/draft/sameConfig")),
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
