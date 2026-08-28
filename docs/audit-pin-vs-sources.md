# 钉死论元 vs 第一手出处对照

研究范围：把 CONTEXT 词表与 ADR 0001 / 0002 / 0004 / 0005 钉死的十条论元，逐条对概念文、引擎、UI、LLM、测试、skill。只找不一致，不改代码、不改概念文、不给修复方案。ADR 0003 已作废，不作为命题源。

命题源：

- `/Users/majiang/Documents/freespace/js/ontos/CONTEXT.md`
- `/Users/majiang/Documents/freespace/js/ontos/docs/adr/0001-partial-overlap-not-same-name.md`
- `/Users/majiang/Documents/freespace/js/ontos/docs/adr/0002-verdict-is-about-substance.md`
- `/Users/majiang/Documents/freespace/js/ontos/docs/adr/0004-judgment-method.md`
- `/Users/majiang/Documents/freespace/js/ontos/docs/adr/0005-pairs-belong-to-a-chain.md`

对照「正文」：`docs/ontos-article.md` 尤其 §3.2。对照「出处」只读下面列出的代码与原文，行号以本次打开的文件为准。

单元格取值：符合 / 打架 / 未实现 / 部分。打架再分为：措辞落后、行为相反、概念已写引擎没做。

## 总表

| 编号 | 命题 | 概念文 | 引擎 | UI | LLM | 测试 | skill | 结论 |
|---|---|---|---|---|---|---|---|---|
| 1 | 五种结论是对这一对候选类描述的现实，不是两个名字、不是表结构 | 符合 `ontos-article.md:114-124` | 符合 `eligibility.ts:22-24` `decide.ts:28-41` | 符合 `PairCard.tsx:28-34` | 部分 `aiSdk.ts:165-167` vs `canned.ts:114-123` | 部分：落地有断言，无「看现实」负例闸 | 符合 `SKILL.md:61-62` | **符合**（建议层仍用名字/字段当倾向，见命题 6） |
| 2 | 名字不同、多行对多列、字段是否同名，都不能当区分标准，也不能当否决 | 符合 `ontos-article.md:114-115,124` | 符合：无同名闸、无跨库闸 `eligibility.ts:1-3,22-24` | 符合：按钮不按同名/跨库禁用 | 部分：真模型提示词符合 `aiSdk.ts:166-167`；罐头用同名字段门槛 `canned.ts:118` | 部分 `m2.test.ts:247-255` 钉的是罐头召回，不是「不能否决」 | 符合 `SKILL.md:54,58` | **部分**（判定路径符合；罐头列对把字段同名当召回门槛） |
| 3 | 部分重叠不依赖属性同名；无同名仍立上位对象，只带同一性标准 | 符合 `ontos-article.md:119,185` | 符合 `eligibility.ts:27-31` `applyVerdict.ts:172-214` | 部分：HINT 未写无同名仍立 `PairCard.tsx:30` | 部分：第一版用字段重合比同一/重叠 `canned.ts:122-123` | 符合 `m3.test.ts:201-214` | 未写该条，不挡 | **符合**（落地已按 ADR 0001；HINT/罐头倾向未写无同名） |
| 4 | 候选对可跨库也可同一库两张表；入围=已上画布、有来源、未定案；共用连接不是否决；没挂来源的不进 | 符合 `ontos-article.md:128` | 符合 `eligibility.ts:17-24` `candidates.ts:35-54` | 符合：空状态不再说必须跨源 `DecisionPanel.tsx:129` | 符合 `aiSdk.ts:166` `slot.ts:23` | 符合 `m3.test.ts:443-464` `routes.test.ts:75-77,92-96` | 符合 `SKILL.md:54,58` | **符合** |
| 5 | 判定办法三问；命中>0 不支持仅名称相似；命中=0 不支持部分重叠；一侧无行不能否定同一；交集率可沉默 | 符合 `ontos-article.md:132-161` | 部分：`overlap.ts:21-26,71` 缺键/空侧不是「沉默」标记；`decide.ts` 不强制硬约束 | 符合 `PairCard.tsx:32,134-140` | 打架：罐头命中=0 可维持阶段 `canned.ts:145-146`；接近全交压过第三问 `canned.ts:156-161` `aiSdk.ts:197` | 符合建议口径 `m2.test.ts:259-285` `m3.test.ts:388-391`；无「decide 硬约束」断言 | 不定案，不挡 | **部分** |
| 6 | 建议/列对只看类名、连接集合、字段名，不看表里的行；会漏、会错 | 符合 `ontos-article.md:128` | 符合 `candidates.ts:16-18,35-41` | 符合：清单来自 `list_candidates` | 符合「不看行」；罐头会漏 `canned.ts:118` | 符合 `m2.test.ts:247-255` `m3.test.ts:343-351` | 符合：只读清单 | **符合** |
| 7 | 候选对属于疑似重复串；一次裁一对；按结论改写还该问谁；不扫行补漏；不从上一对推出下一对结论 | 部分：§3.2 写了串，缺 ADR 0005 上位对象与「已定案不重开」`ontos-article.md:130` | 未实现串图；跳过符合；合并/重叠后全局重召回，行为相反于「只在串里」`candidates.ts:29-66` | 符合一次一对、界面不出现「疑似重复串」`DecisionPanel.tsx:129-133` | 不负责串；重算时罐头会把上位对象和子类配上 `canned.ts:114-118` | 部分：跳过有断言 `m3.test.ts:360-376`；串改写无断言 | 部分：只说一对一对裁 `SKILL.md:62` | **未实现**（串改写）兼 **行为相反**（全局重跑） |
| 8 | 写进本体不是判定依据；同一=合并挂多源；阶段=先并再立派生 status+转化；部分重叠=立上位对象；仅名称相似/跳过=配置不动 | 符合 `ontos-article.md:118-122,185` | 符合 `applyVerdict.ts:127-216` | 符合 HINT 与 toast `PairCard.tsx:28-33,80-84` | 建议不定案，符合 | 符合 `m3.test.ts:131-222` `fieldsUpdate.test.ts:119-142` | 符合：无 decide 工具 `SKILL.md:63` | **符合** |
| 9 | 待确认一次一对；「疑似重复串」四字不出现；空状态不得再说单源不用判/必须跨源 | 概念文可写「串」，不进 UI。符合 | 不进 UI | 符合 `DecisionPanel.tsx:64,129-133`；`src/components` 无「疑似重复串」「单源对象不用判」 | 不进 UI | 符合空状态未测该禁句；面板冒烟 `decisionPanel.test.tsx:46-62` | 符合：不出现这四字 `SKILL.md:56-62` | **符合** |
| 10 | 交集率只答同一批个体，不是同一种事物 | 部分：§3.2 符合 `136-143`；附录一句落后 `1285` | 符合 `overlap.ts:1,44-71` | 符合 `PairCard.tsx:134-140` | 符合第二问「只看交集率」`aiSdk.ts:193` | 符合 `m3.test.ts:75-95` | 不算交集率，不挡 | **符合**（附录措辞落后，见下） |

## 打架 / 未实现（逐条）

### 命题 2 / 6 交界：罐头把字段同名当列对门槛

命题原文（CONTEXT 41、ADR 0002）：

> 名字不同、表是多行还是多列、字段是否同名，都不能当区分标准，也不能当否决。

> 结构建议可以骗人。

出处：

```118:118:src/server/infra/llm/canned.ts
  if (ratio < 0.4 && !nameLike) return null; // 字段对不上、名字也不像，不进候选
```

```247:255:src/tests/m2.test.ts
  it("候选对建议：字段重合才成对；同一库两张表也可以成对", async () => {
    ...
    // a-b、b-c 跨源字段重合；a-c 同一库也可以成对；d 字段对不上
    expect(pairs.map((p) => `${p.class_a}-${p.class_b}`).sort()).toEqual(["a-b", "a-c", "b-c"]);
```

真模型提示词与罐头相反：

```165:167:src/server/infra/llm/aiSdk.ts
          prompt: `你是本体平台的整合顾问。下面是已上画布、有来源的对象（名字、来源连接集合、字段名）。${shapeOf(pairsSchema)}
找出可能描述同一种或同一批现实事物的对，每对给倾向……这是召回，不是判定：表可以是多行对多列，字段可以完全对不上，仍可能是同一。
```

为什么算：判定路径（`pairEligible` / `decide`）没有用同名否决，命题 2 在引擎上仍成立。罐头 `return null` 是召回闸：字段对不上且名字不像的对根本不进待确认。概念文承认「会漏」（`ontos-article.md:128`），故不算「行为相反于入围定义」。它和「不能当否决」不是同一层；测试把「字段重合才成对」写成正例，等于把漏当成规格。归类：**措辞/建议口径部分**，不是落地闸未废。

### 命题 5：命中为零仍可建议「阶段」；接近全交压过第三问

命题原文（CONTEXT 73-74、ADR 0004、概念文 152-159）：

> 命中大于零时数据不支持仅名称相似；命中为零时数据不支持部分重叠。

> 是 | 命中大于零 | 是 | 阶段

> 是 | 全交，或沉默，或命中为零 | 否 | 同一

出处（罐头：命中为零只把「部分重叠」改成「同一」，其它倾向原样留下）：

```145:161:src/server/infra/llm/canned.ts
  if (overlap.count_hit === 0) {
    const tendency = base.tendency === Verdict.Overlap ? Verdict.Same : base.tendency;
    return {
      ...
    };
  }
  if (overlap.rate >= 0.8) {
    return {
      ...
      tendency: Verdict.Same,
      reason: `交集率 ${pct(overlap.rate)}（${counts}），现在多半是同一批个体，倾向同一。`,
    };
  }
```

真模型提示词同样把「接近全交」写成同一，不看第三问：

```197:197:src/server/infra/llm/aiSdk.ts
3. 命中大于零、接近全交 → 同一；介于中间、有状态或日期 → 阶段；介于中间否则 → 部分重叠。
```

第一版若因字段名含 `status` 给出阶段（`canned.ts:122-123`），算完交集命中为零时，罐头仍建议阶段。合成表要求阶段必须「命中大于零」。接近全交时，合成表在第三问为「是」时仍是阶段；提示词与罐头直接给同一。

归类：**行为相反**（建议层，不是 `decide` 闸）。`decide.ts` 不读 `count_hit`，人仍可按下任何按钮——这与概念文「人仍可否决数据，那是不顾证据」（`ontos-article.md:159`）一致，不另记为引擎打架。

### 命题 5：第二问「沉默」在引擎里是报错或 rate=0

命题原文（CONTEXT 74、概念文 136-140）：

> 第二问同一批个体：交集率；一侧取不出取值则沉默。

> 没设同一性标准，或有一侧取不出任何取值，这一问沉默。

出处：

```21:26:src/server/features/integrate/overlap.ts
    if (!hasSources(a.def) || !hasSources(b.def)) {
      throw new EngineReject(MSG.pairNoSources);
    }
    if (!a.def.identity || !b.def.identity) {
      throw new EngineReject(MSG.pairNoIdentity);
    }
```

```71:71:src/server/features/integrate/overlap.ts
    rate: Math.max(a.size, b.size) === 0 ? 0 : hit / Math.max(a.size, b.size),
```

`advise.ts:35-36` 同样：缺唯一键直接 422。UI 用 `count_a === 0 || count_b === 0` 写成「有一侧还没有行，说明不了是不是同一批」（`PairCard.tsx:134-136`），这一支与命题一致。缺唯一键则按钮走错误文案「两边对不上号：有类没设唯一键」（`errors.ts:180`），不是沉默。API 的 `rate` 在空侧仍是 `0`，与「两边都有取值、接近零」同形，只靠条数区分。

归类：**概念已写、引擎部分做成**（空侧靠 UI 解释；缺键是拒绝不是沉默）。

### 命题 7：串改写未实现；合并/重叠后全局重跑结构比对

命题原文（ADR 0005 全文、CONTEXT 88-90、96）：

> 结构比对给出的对当成牵线：能牵到一起的类是一串。裁「同一」或「阶段」后，被并掉的类所牵着的类，改问留下的类——即使当初没有列出过这一对。裁「部分重叠」后，原来跟这两类牵着的对按现在的类再问；新立的上位对象算进这一串，不跟串里每个类都比一遍。裁「仅名称相似」或「跳过」只拿掉这一条牵线。改写成已经定过案的两个类名，不重开。上一对的结论不代替下一对的三问。没被牵上的类不进串；不靠扫行来补漏，也不在串外拉进新类。不采用整串一次裁完，也不采用机器从上一对推出下一对的结论。

概念文 §3.2 写了串和「改问留下的类」，但没有「上位对象算进这一串，不跟串里每个类都比一遍」，也没有「改写成已经定过案的两个类名，不重开」「不在串外拉进新类」（`ontos-article.md:130`）。这是概念文相对 ADR 0005 的缺口，不是相反。

引擎实际：

1. 没有「串」数据结构。`listCandidates` 把**全部有源类**交给 `proposePairs`，读时按 `pairKey(class_a, class_b)` 滤已定案（`candidates.ts:29-66`）。
2. 「跳过 / 仅名称相似」：草稿不变，哈希不变，该对从清单消失。与「只拿掉这一条牵线」一致。有测试：`m3.test.ts:360-376`。
3. 「同一 / 阶段」：`applyVerdict` 删掉被并类（`applyVerdict.ts:130-143`）。类集合变了，`shotHash` 失配，再对**剩下所有有源类**问一遍模型。没有「把 B 的邻居改写成留下的 A」；当初没列出的 A–C 只在新一轮结构比对碰巧召回时才出现。合并后 A 字段变多，原先不在串里的 D 也可能新进清单——与「不在串外拉进新类」相反。
4. 「部分重叠」：新建 `shared_${a}_${b}` 且挂来源（`applyVerdict.ts:179-213`），因此进入下一轮有源类列表（`candidates.ts:35-41`）。罐头按字段重合或名字包含配对（`canned.ts:114-118`）：`shared_po_a_po_b` 包含 `po_a`，且与原子类仍共享识别字段名，会把上位对象和刚裁过的两类再配上。这与「不跟串里每个类都比一遍」相反。

UI 一次只渲染 `pairs[0]`（`DecisionPanel.tsx:132-133`），不出现「疑似重复串」，命题 9 仍符合。清单来源仍是扁平全局召回，不是串。

测试：没有 A–B、B–C 裁同一之后应变 A–C 的断言；没有重叠后上位对象不得与串内每个类成对的断言。

归类：

- **概念已写引擎没做**：串、改问留下的类、上位对象进串、已定案类名不重开。
- **行为相反**：定案后对全部有源类重跑 `proposePairs`（串外可新进；上位对象可与子类成对）。
- 不扫行补漏、不从上一对推出下一对**结论**：仍符合（`proposePairs` 不读行；`decide` 不把上一对 verdict 抄到下一对）。

### 命题 10 / 概念文附录：交集率被写成笼统「硬证据」

命题原文（CONTEXT 92-93）：

> 交集率……只回答同一批个体。

§3.2 正文符合（`ontos-article.md:136-143`）。附录：

```1285:1285:docs/ontos-article.md
| 交集率 | 候选对两端唯一键取值集合的交集占比；判定重合程度的硬证据 |
```

「重合程度」没钉在第二问。§3.2 第一问已写「命中大于零是硬线索」，附录这句容易读成交集率也在答「是不是同一种事物」。

归类：**措辞落后**（附录 vs 词表 / §3.2），引擎与 UI 行为仍只谈同一批个体。

## 分类汇总（不给修法）

### 措辞落后

- `docs/ontos-article.md:1285` 附录把交集率写成「判定重合程度的硬证据」，未钉第二问。
- `docs/ontos-article.md:42` §2「同形异义是名字相同而所指不同」；CONTEXT 55-56 与 §3.2:121 是「不是在描述同一种东西」，不要求名字相同。
- `docs/ontos-article.md:108-110` 节题与起句按「跨系统」收，同节 128 行已写同一库两张表。不是行为相反。
- `docs/ontos-article.md:305` 仍写「经过上面三步」「第三步判定」。
- `src/server/schema/verdict.ts:6,12` 注释「完全等价」「仅名字像」，与「同一种现实事物 / 不是同一种东西」不完全同句。
- `src/server/infra/llm/slot.ts:2`「proposePairs 只看名字和字段」，实现与哈希还看连接集合（`candidates.ts:16-18,39`）。
- `docs/外部Agent编辑画布.md:1145` Open Questions 仍写 `list_candidates` / overlap「本期不做」；同文 469、798 行与 `skills/ontos-canvas/SKILL.md:44,61` 已开放只读 `list_candidates`。与十条论元无直接相反，记一笔文档自相矛盾。

### 行为相反

- 罐头 `reviseWithOverlap`：命中为零可维持「阶段」；比率 ≥0.8 一律「同一」，压过第三问（`canned.ts:145-161`）。真模型提示词第 3 步同样（`aiSdk.ts:197`）。
- `listCandidates` 在同一/阶段/部分重叠之后对**全部剩余有源类**重跑结构比对，而不是只在原串里改写（`candidates.ts:35-59` + `applyVerdict` 改类集合）。结果可把串外类拉进来，也可把 `shared_*` 上位对象和原子类再配成对。

### 概念已写、引擎没做

- ADR 0005 / CONTEXT 的疑似重复串：无图、无「邻居改问留下的类」、无「上位对象进串但不跟每个类比」、无「改写成已定案的两个类名则不重开」。跳过/仅名称相似的「拿掉这一对」已做。
- 第二问「没设同一性标准则沉默」：引擎是 `pairNoIdentity` 拒绝（`overlap.ts:24-26`、`advise.ts:35-36`），不是返回沉默。
- 人不指定两个对象来比（概念文 130「本期未做」）：UI 没有挑任意两类的入口，与概念文一致；`decide` API 不要求该对已在清单里，这是通道宽于界面，不记为未实现。

## 符合的钉（不展开成长文）

- 入围谓词只有有源 ∧ 未定案，共用连接不是否决（`eligibility.ts:1-24`；`m3.test.ts:443-464`；`routes.test.ts:75-77`）。
- 无同名仍立上位对象（`applyVerdict.ts:178`；`m3.test.ts:201-214`）。`commonProperties` 只决定上移哪些属性，不是资格闸（ADR 0001 已废的那道闸代码里不在）。
- 五种落地：同一合并、阶段先并再立 status/转化/动作、重叠立 `shared_*`、仅名称相似/跳过不动（`applyVerdict.ts:127-216`；`m3.test.ts:131-222`）。
- 建议不读行：投喂形状是类名 + 连接集 + 字段名（`candidates.ts:16-18`；改唯一键不重算 `m3.test.ts:343-345`）。
- 待确认一次一对；空状态是「没有发现疑似重复的对象，可以直接发布。」（`DecisionPanel.tsx:129-133`），`src/components` 下无「单源对象不用判 / 必须跨源 / 疑似重复串」。
- 交集率公式 `|∩|/max(|A|,|B|)`，只落计数（`overlap.ts:1,62-74`；`m3.test.ts:75-100`）。UI 文案用「同一批个体」，不用「同一种事物」（`PairCard.tsx:137-140`）。
- skill：同一库两张表也可成对；清单只看不定案；一对一对裁；不出现「疑似重复串」（`SKILL.md:54-63`）。

## 本报告未改

未改引擎、UI、测试、skill、概念文。本文件是对照表，不是补丁说明。
