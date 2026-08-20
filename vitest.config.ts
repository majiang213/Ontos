import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: { "@": resolve(__dirname, "src") }, // 与 tsconfig 的 paths 对齐
  },
  test: {
    pool: "forks", // 测试用 process.chdir 隔离临时目录，必须每文件独立进程；别改成 threads
  },
});
