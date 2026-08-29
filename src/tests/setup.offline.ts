// 默认测试套件零出站门闩：worker 加载时与每个用例后剥掉 OPENAI_API_KEY / ONTOS_TOKEN。
// 加载时剥一次不够：m2 这类用例会在用例内写假 key 测 getLlm 分支，fork worker 跨文件复用会漏到后面的文件，
// 所以 afterEach 再剥一次。用例内仍可以临时写假 key（建议 try/finally 自清，门闩是兜底）。
// 不删 OPENAI_MODEL / OPENAI_BASE_URL：没 key 时 test 走演示实现（DemoLlm），不影响。
import { afterEach } from "vitest";

delete process.env.OPENAI_API_KEY;
delete process.env.ONTOS_TOKEN;

afterEach(() => {
  delete process.env.OPENAI_API_KEY;
  delete process.env.ONTOS_TOKEN;
});
