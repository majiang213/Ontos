# LLM 接入层：接口 `Llm`，演示实现 `DemoLlm`，真模型 `AiSdkLlm`；演示行为按工作空间绑定

模型接入层的旧命名（接口、离线实现、选择器三个名字各自为政）退役。现行四件套：接口 `Llm`——三个出口：问数编译（`nlToQuery`）、逆向建模建议（`proposeObjects`）、候选对倾向建议（`proposePairs` / `proposePair`）；演示实现 `DemoLlm`（无 Key 时的离线确定性：问数走剧本、建模与倾向走机械规则）；真模型 `AiSdkLlm`（OpenAI 兼容协议，Vercel AI SDK）；选择器 `getLlm(workspace)`（组合根 `runtime.ts`）。文件 `slot.ts`→`llm.ts`、`canned.ts`→`demo.ts`。命名带统一后缀 `Llm`，实现关系一眼可辨。

**演示行为按工作空间绑定，不按 Key。** 问数剧本是 test 空间的资产：test 空间的问数永远走剧本——配了 Key 也一样，演示答案必须确定，不随 Key 漂移；其他空间没有模型 Key 直接报错，绝不静默拿演示剧本顶替（错答案比报错糟）。有 Key 时所有空间的所有出口都走真模型（真模型走查的零温度 + 种子由此成立）。逆向建模与倾向建议的离线启发式是通用规则，随演示实现只在 test 空间的无 Key 分支可达。

**注册工作空间不产生已发布版本。** 注册只落空间行与工作行；无发布时 `latestVersion` 回退种子（version 0）但不再落库——「已发布 v1」必须由人发布产生。例外：test 的演示模板随注册发布成 v1（问数与动作在演示空间开箱即用）。
