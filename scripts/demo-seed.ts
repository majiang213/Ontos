// 演示播种：把「一家公司 · 三波接入」的十二套源系统写成可连接的 SQLite 文件 + 列注释 sidecar（.ontos-demo/，gitignored）。
// 用法：npm run demo:seed。幂等（重复运行整份覆盖）。只写文件——不动元库、不注册连接；
// 打印的十二行就是数据源抽屉接入要用的答案（给人看的名字 / 连接名 / 类型 / 绝对路径）。
// 裸 node 直接跑（type stripping）：只能引 demoSystems.ts 这种叶子模块（仓库其它 TS 用省略扩展名的相对导入，node 解不了）。

import { writeDemoFiles } from "../src/server/infra/demoSystems.ts";

try {
  const files = writeDemoFiles();
  console.log("已写出 12 套演示库（重复运行会整份覆盖）。数据源抽屉左栏按下面接入（手动接入照填）：\n");
  for (const f of files) {
    console.log(`${f.title}\t连接名 ${f.connection}\t类型 SQLite 文件（演示）\t文件路径 ${f.path}`);
  }
  console.log("\n去画布：新建空白工作空间 → 左下角「数据源」逐套接入（不要用 test 空间）。");
} catch (e) {
  // 机器判据走结构字段（六轴⑥，不看文案）：fs 错误看 code；node:sqlite 的 busy 看 errcode（5 = SQLITE_BUSY）
  const err = e as NodeJS.ErrnoException & { errcode?: number };
  const fileBusy = err.code === "EBUSY" || err.code === "EPERM" || err.code === "EACCES" || err.errcode === 5;
  if (fileBusy) {
    console.error("演示库文件被占用，先停掉正在跑的开发服务再播种");
  } else {
    console.error(`播种失败：${e instanceof Error ? e.message : String(e)}`);
  }
  process.exit(1);
}
