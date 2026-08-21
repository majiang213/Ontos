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
