# 过时文档与代码注释审计

审计日期：2026-08-28。基准提交：0246606（含 406a895 串改写、077f9f8 判定看实质、adbc258 MCP 十工具与 list_candidates 开放）。方法：逐条对源码或另一份文档的第一手出处；只列事实性出入，不挑措辞风格。本报告只读，未改任何被排查文件。

## 1. 过时内容清单（文档）

| 文件:行号 | 现状内容摘要 | 过时原因（第一手出处） | 处置建议 |
|---|---|---|---|
| README.md:9 | 「358 条测试全绿（`npm test`）」 | 实跑 `npx vitest run`：40 个文件 373 条全绿（2026-08-28 实测） | 改成 373 |
| README.md:101 | 「358 条用例不连外网、随时可跑」 | 同上，373 条 | 改成 373；或两处都改成不带数字的写法（全绿以 `npm test` 为准），免再漂移 |
| docs/Ontology平台MVP设计文档.md:13 | V2.6 变更注记：「元库 DDL 按方言分文件（`src/server/meta/ddl/sqlite.ts` 与 `mysql.ts`）」「对外主入口是 MCP 九个工具」 | DDL 实为 `.sql` 三份：`src/server/meta/ddl/` 下 `sqlite.sql / mysql.sql / pg.sql`（同文档 :431 自己引的就是 `mysql.sql / pg.sql`，自相矛盾）；MCP 现为十个工具：`src/app/api/[workspace]/mcp/tools.ts:1`（「十个工具」）与 TOOLS 表 :72-194（含 `list_candidates` :158-164） | 「sqlite.ts / mysql.ts」改「sqlite.sql 起按方言一库一份」；「九个工具」改「十个工具」 |
| docs/Ontology平台MVP设计文档.md:245 | 「MCP（`POST /api/mcp`，九个工具）为主入口」 | 十个工具，出处同上（mcp/tools.ts:72-194）；`POST /api/mcp` 也已带空间路径段（skills/_shared/mcp-access.md；路由目录 `src/app/api/[workspace]/mcp/`） | 改「十个工具」；端点顺手改成 `/api/<空间名>/mcp` |
| docs/Ontology平台MVP设计文档.md:469 | 「经 MCP 调九个工具（query / run_action / propose_objects / propose_action / list_classes / read_class / search / list_tables / edit_draft）」 | 清单缺 `list_candidates`（mcp/tools.ts:158-164），且 AGENTS.md:192 已把「疑似重复清单只读开放」写成纪律 | 改为十个工具并补上 `list_candidates` |
| docs/Ontology平台MVP设计文档.md:430 | 「其余 6 张元数据表（conn_source、adj_decision、adj_overlap、ont_question、log_query、log_action）」 | 现 7 张：`adj_candidates` 于 1a90eeb 加入（`src/server/meta/ddl/sqlite.sql:72`；注释「候选对快照」）；落库代码 `src/server/meta/stores/adjudication.ts:1-2` | 「6 张」改「7 张」，清单补 `adj_candidates` |
| docs/Ontology平台MVP设计文档.md:504 | 附录 B 对照：「§2 五种结论与三层证据链 → 文章 §3.2：五种结论的处理、**三步判定**、候选对、交集率」 | 判定办法 077f9f8 已改三问，非「三步」：ontos-article.md:126 节题「判定办法」、:149「三问合成结论」；代码侧 `candidates.ts:16-17`（「三问改口规则」）、`canned.ts:137`（「按三问改口」） | 「三步判定」改「三问判定」；「三层证据链」是 AGENTS.md:137 在册术语可保留，也可顺势写「三问」对齐 |
| docs/ontos-article.md:42 | 「同形异义是两个类不是在描述同一种东西：两个系统里都有「账户」……」 | 语义本身已是新口径；但同文附录 A:1261 仍是旧定义「名字相同而所指不同」，§2 与附录打架。CONTEXT.md:55-56 与 verdict.ts:12（「不是在描述同一种东西」）均不要求名字相同 | 附录 A:1261 改成「不是同一种东西（名字可以像，也可以不像）」之类；§2 正文不动 |
| docs/ontos-article.md:1261 | 附录 A：「同形异义 ｜ 名字相同而所指不同」 | 旧定义要求「名字相同」，与新口径不符：CONTEXT.md:55-56（「即使名字像，也不是同一」）、verdict.ts:12、ontos-article.md:121（「两个类不是在描述同一种东西」） | 改成「两个类不是在描述同一种东西」；不要求名字相同 |
| docs/ontos-article.md:1258 | 附录 A：「类等价 ｜ 两个名字指同一类」 | 旧定义以名字为主语，与「看实质不看名字」冲突：CONTEXT.md:44-46（「两个类描述同一种现实事物」「名字不是判定」）、verdict.ts:7、§3.2:118 | 改成「两个类描述同一种现实事物」 |
| docs/ontos-article.md:305/307/299/301 | §3.3 起句「经过上面三步，配置中已有类、同一性标准和源映射。**第三步判定**的是这两个被比对的类之间的关系」 | 077f9f8 后判定办法是「三问」（§3.2:126-161），「经过上面三步」可被读成把旧「三步判定」当既成步骤；§3.2 与 §3.3 之间没有交付物链条（候选对、交集率不进配置，:190 自己写明），「配置中已有」直接挂「三步」也断裂 | §3.3 起句改为按 §3.2 引用（如「经过 §3.2 的逆向建模与对齐判定，配置中已有……」），「第三步判定」改「§3.2 的判定」；299/301 同改 |
| docs/外部Agent编辑画布.md:1145 | Open Questions：「`list_candidates` / `overlap` 作为只读 MCP：**本期不做**。Agent 用自然语言请人打开「待确认」」 | `list_candidates` 已于 adbc258 开放只读：mcp/tools.ts:158-164；同文档 :469 的权限表自己写「允许只读（list_candidates）」、:782 skill 表也含它；skills/ontos-canvas/SKILL.md:44 在用 | 删掉该条或改「已落地：`list_candidates` 只读开放；overlap 仍无 MCP（关卡在人）」 |
| docs/外部Agent编辑画布.md:17 | 头注：「op 以 `src/server/schema/ops.ts` 为准（16 个：14 条改本体 + save_layout / save_edge_bend）」 | 属实，不算过时——`schema/ops.ts:14-77` 数得 16 个 variant，ops/index.ts:1 与 AGENTS.md:197 同口径。列出只为防止后续误报 | 不动 |
| docs/真模型端到端测试.md:213 | 「候选人对象在乘号前、员工对象在后，不对就**对调**」 | 对调入口已下线（adbc258 提交说明「对调两端下线」；PairCard.tsx:225-233 现是点「哪个时期更早」按钮定顺序，无独立对调钮） | 改成「阶段卡上点谁更早；顺序反了点另一个类名」 |
| docs/真模型端到端测试.md:308 | 排查表「交集率……对调后条数跟着类走」 | 同上：对调入口下线；但「条数跟着类走」的机制还在（PairCard.tsx:21-26 `alignRate` 按类名对齐条数） | 改「顺序重选后条数跟着类走」 |
| docs/真模型端到端测试.md:196 | 「被并掉的类会换成幸存者再出新对——只准跳过 / 仅名称相似」 | 串改写落地后（406a895，chain.ts:10-41、candidates.ts:102-133），被并类牵着的对会**改写成留下的类再出**（标「还该问」），第二波就该按三问裁「账号 × 已合并人员」；同文档 :214 自己也把这一对列成「跳过或仅名称相似」，口径一致，但「只准」的原因已变（串内续问，不是防再并） | 表述可保留结论，建议补一句机制：「串会把被并类的对改写给幸存者，这类续问只准跳过 / 仅名称相似」 |
| docs/真模型端到端测试.md:321 | 「生产槽位不设 `temperature: 0`；live 自检不进 CI」 | 077f9f8 已改成零温度固定种子：`src/server/infra/llm/aiSdk.ts:43-45`（`DECODING = { temperature: 0, seed: 42 }`，注释「同一份输入必须给同一份答案」） | 删除前半句或改「生产槽位固定零温度 + 种子（同输入同答案）」 |
| README.md:34 | 裁决步骤描述「先确认唯一键……再算交集率，你据此把这两类裁决为五种关系之一」 | 与现行为一致（DecisionPanel.tsx:1 两段解锁）；无出入，列出防误报 | 不动 |
| docs/TODO.md 全文 | 问数 API 台账移除记录与「旧实现去哪找」 | 引用的旧路径在 git 历史里（功能 2026-08-21 移除），文中已自注日期；`src/components/ChatPage.tsx` 现已不存在，但该句说的是「移除当次提交前的 git 历史」，仍成立 | 保留；无改动 |

## 2. 代码注释问题（只列事实性错误）

全量扫了 `src/server`、`src/app/api` 的文件头与 integrate/ontology/llm/meta 各域行内注释，引用了已删符号（isCrossSource、sharedSourcesMsg、SAME_SOURCE_OK_VERDICTS、MSG.sharedSources、MSG.overlapNoCommon）的注释：**零命中**（`grep` 全 src 无这些符号）。机制描述基本都已随 406a895/077f9f8/0246606 更新（eligibility.ts:1-3、candidates.ts:1-3、chain.ts:1-4、canned.ts:137/145-160、advise.ts:37-39、aiSdk.ts:186-200）。仅一条失准：

| 文件:行号 | 现状内容摘要 | 过时原因（第一手出处） | 处置建议 |
|---|---|---|---|
| src/server/infra/llm/canned.ts:31 | 「形状与 generateText + Output.object 产物一致，过同一道 Zod」 | 真模型槽位 8c698ca 起不用 Output.object / response_format，是 generateText 出文本抠 JSON：aiSdk.ts:1-4（「generateText({ model, prompt }) → 文本抠 JSON」「完全不下发 response_format」） | 改「形状与真模型槽位出槽 JSON 一致，过同一道 Zod」 |

另两处边界情况（注释本身没错，但引用的外部文档行号已漂移，记录在案不计错误）：

- `src/server/features/integrate/normalize.ts:1` 写「《ontos-article.md》§3.2 第二步」——article 现只有「第一问/第二问/第三问」，「第二步」是旧三步行话，但读者能对到「第二问」；建议顺手改「第二问」。
- `src/server/features/integrate/chain.ts:1`、`eligibility.ts:1` 等引用「《ontos-article.md》§3.2」「ADR 0005」，均为节级引用，未漂。

## 3. 最近提交文档的保留价值分析

### CONTEXT.md（077f9f8 新建，107 行概念词表）

- 与 AGENTS.md 的重叠：约六成词条（五关系类型、候选对、疑似重复串、交集率、归一化、判定办法）AGENTS.md:113-142 已有对应条目。但分工不同：CONTEXT 写概念层的「是什么 / 判定依据 / 不是什么」（Avoid 单列），AGENTS.md 是工程纪律 + UI 说法对照。重复存在但不是全文复制。
- 被引用情况：仓库内除 audit-pin-vs-sources.md:7 外无任何文件引用 CONTEXT.md（`grep CONTEXT\.md` 全仓仅 audit 一份）；代码注释引用的是《ontos-article.md》与 ADR 编号，不引 CONTEXT。
- 贬值风险：低——它是概念文，不锚行号；只要「判定看实质 / 三问 / 串」不再大改就稳定。
- **建议：保留。** 一句理由：它是唯一把十条论元写成可对照命题的概念层文档（audit 文档的命题源），AGENTS.md 的条目是工程纪律不是定义；若要消重，应把 AGENTS.md:113-142 的重复条目改成指 CONTEXT，而不是删 CONTEXT。

### docs/adr/0001（部分重叠不依赖属性同名）

- 内容：资格闸「无同名不许裁部分重叠」已废的定案记录。代码已落地（eligibility.ts:26-28 注释「没有同名不挡裁决」）。
- 被引用：audit-pin-vs-sources.md:8、命题 3；代码注释未直接引 0001 编号，但 eligibility.ts:28 注释就是这条 ADR 的内容。
- **建议：保留。** 一句理由：三行小文件，记的是「曾把落地能力当判定资格、已废」这一否定性决定——这类决定最容易被重新引入，ADR 正是防回摆的存档。

### docs/adr/0002（判定看所指，不看名字和表结构）

- 被引用：audit-pin-vs-sources.md:9；canned.ts:160、chain.ts:1 引的是 0004/0005；0002 的实质内容已进 ontos-article.md:114-115 与 CONTEXT.md:41。
- **建议：保留。** 一句理由：与 0001 同，是否定性决定（名字/表结构不能当否决），存档成本三行，防回摆价值高。

### docs/adr/0003（判定办法尚未按所指设计完整——已被 0004 取代）

- 内容：自认「当时三步没有给出三问的操作化办法」，明写「已被 0004 取代」。
- 被引用：仅 audit-pin-vs-sources.md:3（作为「已作废，不作为命题源」的排除声明）与 0004 末句（「0003 所说由本条补上」）。
- **建议：保留。** 一句理由：它已自带废止声明，且 0004 与 audit 文档都以它为锚（「0003 由本条补上」「0003 已作废」）——删掉会让这两处的引用落空；ADR 链的价值正在保留被取代者以见演进。若要更清楚，可在文首加一行「**状态：已废（0004 取代）**」大字标记，现状只有第三句提及，扫读容易漏。

### docs/adr/0004（判定按三问合成）

- 被引用：canned.ts:160（「与 §3.2 合成表、ADR 0004 一致」——代码唯一直接引 ADR 编号的注释之一）、audit-pin-vs-sources.md:10。内容与 ontos-article.md §3.2 判定办法、CONTEXT.md:73-76 重叠但有增量：「同一不要求现在是同一批个体」「一行一个或一列一个不改定义」两句正文里更凝练。
- **建议：保留。** 一句理由：三问判定办法的定案原点，代码注释直接引它，且 0246606 的修正（接近全交不压第三问、命中为零阶段立不住）是按它的框架做的。

### docs/adr/0005（候选对属于一串）

- 被引用：chain.ts:1（「疑似重复串 ……（《ontos-article.md》§3.2、ADR 0005）」）、audit-pin-vs-sources.md:11。406a895 的串改写就是按它实现（rewriteAfterVerdict 逐条对应 ADR 五种结论后的改写规则）。
- **建议：保留。** 一句理由：串语义的唯一定案文本（ontos-article.md:130 只写了子集：缺「上位对象不跟每个类比」「已定案不重开」，这些只在 0005 与 chain.ts 注释里），删了串规则就没有可引的单一出处。

### docs/audit-pin-vs-sources.md（adbc258 时代的十条论元对照表）

- 内容性质：时间点快照审计，行号全部锚在当时打开的文件。
- 贬值情况：**结论已大面积过期**——其「行为相反」「未实现」两大节的病灶在随后四个提交里全部修掉：
  - 命题 5（命中为零维持阶段、≥0.8 压第三问）：已由 0246606 修复（canned.ts:145-160「非空命中为零阶段立不住」「比率不再单独压过第三问」；aiSdk.ts:193-199 同步改）；
  - 命题 7（串未实现、全局重跑拉串外）：已由 406a895/45e7d83 实现（chain.ts:10-41、candidates.ts:83-89 并类失配沿用存活对不拉串外）；
  - 「措辞落后」清单也多数已修：ontos-article.md:1285 已由 0246606 钉回第二问（现为「回答是不是同一批个体，不回答是不是同一种事物」）、§3.2:108-110 已去「跨系统」、verdict.ts:6,12 注释已改成新口径、slot.ts:2 已写「连接集合」。
  - 仍未修、与本报告一致的只剩：ontos-article.md:305「经过上面三步」、:1261「同形异义=名字相同而所指不同」、:1258「类等价=两个名字指同一类」、外部Agent编辑画布.md:1145。
- **建议：保留但需标注时效。** 一句理由：它是 ADR 落地前的病灶清单，有历史价值（说明 077f9f8 等四个提交为什么那样改），但结论表已不反映现状，应在文首加一行「**时点快照（adbc258）；行为相反/未实现各条已由 406a895 / 45e7d83 / 077f9f8 / 0246606 修复，现状对照见 docs/audit-stale-docs.md**」，否则读者会把「未实现串」当成当前事实。

## 4. 查过但未发现问题的高危区

- **已删符号全仓引用**：isCrossSource / sharedSourcesMsg / SAME_SOURCE_OK_VERDICTS / MSG.sharedSources / MSG.overlapNoCommon 在 src 与全部文档零命中。
- **AGENTS.md 全表**：op 数（16 = 14 + save_layout/save_edge_bend，与 schema/ops.ts:14-77、ops/index.ts:1 一致）、十二套演示系统（demoSystems.ts:17-30 恰 12 条）、MCP 工具与入口对照表（10 工具与 mcp/tools.ts 一致；「list_candidates 只读开放」与注册表一致）、单源登记处符号（NAME_RE / sourceKeyProp / conversionActionName / QUESTION_PACKS 等抽查均在位）、候选快照/ADVICE_RULES_VERSION=3（candidates.ts:16-17 注释与行为一致）。
- **四个 SKILL.md**：工具表与 mcp/tools.ts 逐个对过（含各工具接不接受 space：query/run_action/propose_objects/list_tables/list_candidates/edit_draft 拒 space 与 ToolDef.space 标志一致）；`convert` 只属于 test 空间的提醒与 fixture 一致；无「对调」「跨源门槛」残留（ontos-canvas:55/59 反而已写「同一库两张表也可能成对」）。
- **UI 文案与剧本**：PairCard HINTS（:28-33）、「算一算交集率」、两段解锁、问题集期望数字（questionPacks.ts 与真模型端到端测试.md §2.6/§3.3/§4.4 四包逐条一致，含「验收后」101/80）。
- **交集率实现口径**：公式 |∩|/max(|A|,|B|)、MAX_SCAN=50_000、缺键 422、空侧 rate=0 由 UI 解释（overlap.ts:31/51/71，PairCard.tsx:133-136），与 article:145 的「超过 5 万行拒绝」、CONTEXT「可沉默」一致（沉默=UI 解释层，audit 已记此归类，不算新过时）。
- **元库 DDL 与记录表**：sqlite/mysql/pg 三份 .sql 同构；`stores/adjudication.ts:1-2` 注释与实际三表（adj_decision/adj_overlap/adj_candidates）一致。
- **代码文件头注释**：src/server 全域 49 个文件头逐个扫过，除 §2 表所列两条外，机制描述（串改写、快照钉住、三问改口、零温度种子、无状态 CAS）均与实现同步。

## 本报告未改

未改任何被排查的文档与源码；本文件是对照结论。

## 处置结果（2026-08-28 补记）

§1 表的 14 条实质过时与 §2 表的 1 条注释失准已全部按「处置建议」落地（README 两处改为不带数字的写法防再漂移；概念文 §3.3「三步」改按节名引用）；§3 的保留建议照此执行：ADR 0003 文首加废止标记，audit-pin-vs-sources.md 文首加时效标注。
