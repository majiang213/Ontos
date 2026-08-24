import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: { "@": resolve(__dirname, "src") }, // 与 tsconfig 的 paths 对齐
  },
  test: {
    pool: "forks", // 全局运行态（globalThis 上的 runtime）需进程级隔离，必须每文件独立进程；别改成 threads
  },
});
