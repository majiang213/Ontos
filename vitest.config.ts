import { configDefaults, defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  resolve: {
    alias: { "@": resolve(__dirname, "src") }, // 与 tsconfig 的 paths 对齐
  },
  test: {
    pool: "forks", // 全局运行态（globalThis 上的 runtime）需进程级隔离，必须每文件独立进程；别改成 threads
    setupFiles: ["src/tests/setup.offline.ts"], // 零出站门闩：加载时与 afterEach 剥 OPENAI_API_KEY / ONTOS_TOKEN
    exclude: [...configDefaults.exclude, "src/tests/live/**"], // live 用例（若存在）不进默认套件；展开默认列表，不整份覆盖
  },
});
