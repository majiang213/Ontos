// 域拒绝类型一处 —— 各层按类型映射错误码（路由 422 / MCP -32000 / 400），不再散在五个文件。
// query、config、infra、app 各层都向下依赖这里；映射阶梯留在 _shared 与 mcp/route，不动。
// 文案也一处：用户看得见的错误消息全部收在 MSG（本文件末尾）——引擎与路由不内联魔法字串，
// 改文案只动 MSG；术语纪律（AGENTS.md 语言规则：白话优先、UI 词与术语表对齐）在这一处把守。

/** 引擎拒绝：请求或配置里的名字对不上已发布配置。路由按 422 处理；其它异常是引擎故障，按 500。 */
export class EngineReject extends Error {}

/** 草稿操作不合法：名字重了、对象不存在、被引用未解除等。 */
export class DraftReject extends Error {}

/** 连接生命周期拒绝：bad_request 对形状/路径，rejected 对资格（演示源、连不上、占用）。 */
export class ConnectionReject extends Error {
  constructor(
    message: string,
    readonly kind: "bad_request" | "rejected" = "rejected"
  ) {
    super(message);
    this.name = "ConnectionReject";
  }
}

/** 工作空间域拒绝（名字不合法、已存在）：路由按 422 处理，与其它域的 Reject 同层。 */
export class WsReject extends Error {}

/* ---------- 用户看得见的错误文案（唯一出处） ----------
   按域分节：草稿编辑 op / 引用 trail / 校验 / 执行 / 查询 / 基础设施 / 路由。
   规则：文案字节级稳定（测试按子串断言）；新增报错一律加在这里，不在调用点现写。 */
export const MSG = {
  // 草稿编辑 op（draft/ops、editDraft、versions、canvasPack）
  classNotFound: (name: string) => `类不存在：${name}`,
  classExists: (name: string) => `类已存在：${name}`,
  classNameBad: "类名必须是小写字母/数字/下划线，字母开头",
  classNameBadOn: (name: string) => `类名必须是小写字母/数字/下划线，字母开头：${name}`,
  classNotFoundImport: (name: string) => `类不存在：${name}，新建类请先 import_objects`,
  classNotFoundReplace: (name: string) => `类不存在：${name}，新建请用 import_objects`,
  propNameBad: "属性名必须是小写字母/数字/下划线，字母开头",
  propExists: (name: string) => `属性已存在：${name}`,
  propNotFound: (name: string) => `属性不存在：${name}`,
  propNotOnClass: (cls: string, prop: string) => `${cls} 上没有属性 ${prop}`,
  propIdentityNoDelete: "唯一键不能直接删，先换一个",
  propDerivedNoIdentity: "派生属性不能当识别字段",
  linkNameBad: "关系名必须是小写字母/数字/下划线，字母开头",
  linkInverseBad: "反向名必须是小写字母/数字/下划线，字母开头",
  linkExists: (name: string) => `关系已存在：${name}`,
  linkNotFound: (name: string) => `关系不存在：${name}`,
  stillReferenced: (name: string, refs: string[]) => `${name} 仍被引用：${refs.join("、")}`,
  propStillReferencedRename: (name: string, refs: string[]) => `${name} 仍被引用：${refs.join("、")}，先解除引用再改名`,
  linkStillReferencedRewire: (name: string, refs: string[]) => `${name} 仍被引用：${refs.join("、")}，先改引用它的动作再改接`,
  linkStillReferencedRematch: (name: string, refs: string[]) => `${name} 仍被引用：${refs.join("、")}，先改引用它的动作再改配对`,
  linkStillReferencedRename: (name: string, refs: string[]) => `${name} 仍被引用：${refs.join("、")}，先改引用它的动作再改名`,
  transitionNoRewire: "转化关系的两端不能改接",
  linkSameEnds: "关系的两端不能是同一个对象",
  linkNoPairProps: "新端点上没有任何属性，配不出配对字段",
  transitionNoRematch: "转化关系没有配对字段可改",
  actionNotFound: (name: string) => `动作不存在：${name}`,
  unknownOp: (input: unknown) => `未知操作：${JSON.stringify(input)}`,
  replaceBlocked: (name: string, blockers: string[]) => `${name} 不能整对象替换：${blockers.join("；")}。请用增删字段等逐步操作`,
  draftChanged: (rev: number) => `草稿已变（rev=${rev}），请重新读取再改`,
  versionNotFound: (version: number) => `版本不存在：v${version}`,
  versionUnreadable: (version: number, detail: string) => `配置不合法：v${version} 的内容读不回来（${detail}）`,
  workingCopyUnreadable: (detail: string) => `工作副本读不回来：${detail}`,

  // 引用 trail（draft/refs 的引用清单前缀）与资格/定位文案（eligibility、tables）
  trailSource: (src: string) => `源映射 ${src}`,
  trailAxiom: (name: string) => `公理 ${name}`,
  trailLink: (name: string) => `关系 ${name}`,
  trailDerived: (cls: string, prop: string) => `派生属性 ${cls}.${prop}`,
  trailDerivedProp: (prop: string) => `派生属性 ${prop}`,
  trailAction: (cls: string, act: string) => `动作 ${cls}.${act}`,
  sharedSources: (shared: string[]) => `这两个对象有共同来源（${shared.join("、")}），不算疑似重复`,
  tableNotFound: (connection: string, table: string) => `表不存在：${connection}.${table}`,

  // 校验 validate 与取值规约（draft/validate、schema/spec）——一律「配置不合法：」前缀
  cfgLinkUnknown: (trail: string, ln: string) => `配置不合法：${trail} 引用了不存在的关系 ${ln}`,
  cfgFilterPropUnknown: (trail: string, cls: string, k: string) => `配置不合法：${trail} 过滤了 ${cls} 上不存在的属性 ${k}`,
  cfgIdentityMissing: (cls: string, identity: string) => `配置不合法：${cls} 的 identity 指向不存在的属性 ${identity}`,
  cfgIdentityDerived: (cls: string, identity: string) => `配置不合法：${cls} 的 identity 指向派生属性 ${identity}`,
  cfgNoRowKey: (cls: string, src: string) => `配置不合法：${cls}.${src} 没有认行依据（类无 identity，条目也无 key）`,
  cfgFieldsMissingKey: (cls: string, src: string, keyProp: string) => `配置不合法：${cls}.${src} 的 fields 缺对齐属性 ${keyProp}`,
  cfgDerivedInFields: (cls: string, src: string, prop: string) => `配置不合法：派生属性不得进 fields（${cls}.${src} 的 ${prop}）`,
  cfgFieldsUnknownProp: (cls: string, src: string, prop: string) => `配置不合法：${cls}.${src} 的 fields 指向不存在的属性 ${prop}`,
  cfgDerivedUnknownSource: (cls: string, prop: string, src: string) => `配置不合法：${cls}.${prop} 的派生规则指向不存在的源条目 ${src}`,
  cfgDerivedUnmappedProp: (cls: string, prop: string, src: string, k: string) => `配置不合法：${cls}.${prop} 的派生规则在 ${src} 上过滤未映射的属性 ${k}`,
  cfgDerivedUnknownProp: (cls: string, prop: string, c: string, k: string) => `配置不合法：${cls}.${prop} 的派生规则过滤了 ${c} 上不存在的属性 ${k}`,
  cfgDerivedUnknownLink: (cls: string, prop: string, ln: string) => `配置不合法：${cls}.${prop} 的派生规则引用了不存在的关系 ${ln}`,
  cfgDerivedSpecialKey: (cls: string, prop: string, src: string, k: string) => `配置不合法：${cls}.${prop} 的派生规则里 ${src} 的过滤不支持 ${k}`,
  cfgLinkEndMissing: (link: string, end: string) => `配置不合法：关系 ${link} 的端点 ${end} 不存在`,
  cfgMatchPropMissing: (link: string, side: string) => `配置不合法：关系 ${link} 的 match 指向不存在的属性 ${side}`,
  cfgMatchPropDerived: (link: string, side: string) => `配置不合法：关系 ${link} 的 match 指向派生属性 ${side}`,
  cfgTransitionNotWhen: (link: string, from: string, prop: string) => `配置不合法：关系 ${link} 的 transition.property 不是 when 派生（${from}.${prop}）`,
  cfgTransitionValues: (link: string, from: string, to: string) => `配置不合法：关系 ${link} 的 transition 阶段值不在派生规则里（${from} / ${to}）`,
  cfgEffectClassMissing: (cls: string, act: string, object: string) => `配置不合法：${cls}.${act} 的效应指向不存在的类 ${object}`,
  cfgEffectPropMissing: (cls: string, act: string, object: string, prop: string) => `配置不合法：${cls}.${act} 的效应写了不存在的属性 ${object}.${prop}`,
  cfgEffectPropDerived: (cls: string, act: string, object: string, prop: string) => `配置不合法：${cls}.${act} 的效应写了派生属性 ${object}.${prop}`,
  cfgRequestClassMissing: (cls: string, act: string, target: string) => `配置不合法：${cls}.${act} 的 $request 指向不存在的类 ${target}`,
  cfgInformObjectMissing: (cls: string, act: string, object: string) => `配置不合法：${cls}.${act} 的 inform 对象 ${object} 不存在`,
  cfgInformOutletUnknown: (cls: string, act: string, outlet: string) => `配置不合法：${cls}.${act} 的 inform 指向未声明的出站 ${outlet}`,
  cfgEffectIdentify: (where: string, object: string) => `配置不合法：${where} 的效应认人必须写明：${object} 缺 identity 或 filter`,
  cfgEffectLinkUnknown: (where: string, name: string) => `配置不合法：${where} 的效应 link 指向不存在的转化关系 ${name}`,
  cfgTransitionNotOn: (name: string, cls: string) => `配置不合法：转化关系 ${name} 不在 ${cls} 上`,
  cfgTransitionOrphan: (link: string) => `配置不合法：转化关系 ${link} 没有任何动作的效应 link 引用它——先写一条同样 link 该转化关系的替代动作，再删旧的`,
  cfgValueNoArray: (where: string) => `配置不合法：${where} 的取值不接受数组`,
  cfgValueFromBad: (where: string, detail: string) => `配置不合法：${where} 的取值 { property } 组合的 from 只许 current/request：${detail}`,
  cfgValueNoCurrent: (where: string, detail: string) => `配置不合法：${where} 没有当前个体，取值不能来自 current：${detail}`,
  cfgValueGenerated: (where: string, detail: string) => `配置不合法：${where} 的 from: generated 只许用在 create 效应且目标属性带 generate 列表：${detail}`,
  cfgValueUnknown: (where: string, detail: string) => `配置不合法：${where} 的取值来源不认识：${detail}`,
  cfgOperandArrayLiteral: (where: string) => `配置不合法：${where} 的数组元素只许是字面量`,

  // 动作执行（engine/action，运行期拒绝，被 runAction 收成 stage=effect/pre 的结果）
  linkOnlyTransition: (link: string) => `link 只用于转化关系：${link}`,
  transitionNotOnClass: (link: string, cls: string) => `转化关系 ${link} 不在 ${cls} 上`,
  effectIdentify: (object: string) => `认人必须写明：${object} 缺 identity 或 filter`,
  effectNoTarget: (object: string) => `效应找不到对象：${object}`,
  effectPropUnknown: (cls: string, prop: string) => `效应里的名字对不上配置：${cls}.${prop}`,
  derivedNoWrite: (cls: string, prop: string) => `派生属性不能写入：${cls}.${prop}`,
  noSourceCarries: (cls: string) => `没有源能承接 ${cls} 的全部所赋属性`,

  // 裁决（adjudication：资格闸与定案应用；applyVerdict 的 Error 会被 mutateDraft 包装成用户可见拒绝）
  classPairNotFound: (a: string, b: string) => `类不存在：${a} 或 ${b}`,
  stageNeedsTwoSources: "阶段裁决需要两个不同的源条目",
  stageStatusClash: (a: string) => `阶段裁决需要立派生属性 status，但 ${a} 上已有同名属性——先把它改名或删掉`,
  stageLinkNameClash: (name: string) => `关系名 ${name} 已存在——换个阶段名再裁`,
  stageActionNameClash: (name: string) => `动作名 ${name} 已存在——换个阶段名再裁`,
  overlapNoCommon: "两类没有公共属性（识别字段除外），立不了上位对象",
  pairNoSources: "无源对象不算疑似重复（先给它挂来源）",
  pairNoIdentity: "两边对不上号：有类没设唯一键",
  identityColumnTooBig: (cls: string, max: number) => `${cls} 的识别列超过 ${max} 行，交集算不了（先收窄范围）`,
  decideClassMissing: "类不存在，先刷新画布",
  decideNoSources: "无源对象不进裁决（先给它挂来源）",

  // 查询（engine/query：表达式求值、过滤形状、个体读取、投影/聚合/展开）
  classNotInConfig: (name: string) => `配置中没有类：${name}`,
  dateExprBad: (expr: string) => `非法日期表达式：${expr}`,
  dateFloorBad: (expr: string) => `日期取整只支持 /w /d /h /m /s：${expr}`,
  numExprNoValue: (tok: string) => `数字表达式取不到数：${tok}`,
  numExprBad: (expr: string) => `非法数字表达式：${expr}`,
  dateLiteralBad: (s: string) => `非法日期字面量：${s}`,
  exprBad: (s: string) => `非法表达式：${s}`,
  valueMissing: (prop: string) => `取不到值：${prop}`,
  requestParamMissing: (prop: string) => `请求缺参数：${prop}`,
  identityMissing: "请求缺识别值 identity",
  generatedUnsupported: (prop: string) => `该路径不支持 from: generated（属性 ${prop}：发号只在 create 投影里可用）`,
  valueSourceUnknown: (detail: string) => `无法识别的取值来源：${detail}`,
  noGenerate: (cls: string, prop: string) => `${cls}.${prop} 没有 generate`,
  noSequence: "没有计数器，不能发号",
  generateItemUnknown: (detail: string) => `无法识别的 generate 项：${detail}`,
  operandMissing: (prop: string) => `操作数取不到值：${prop}`,
  operandUnknown: (detail: string) => `无法识别的操作数：${detail}`,
  linkNestTooDeep: (trail: string) => `${trail}：$link 嵌套最多三层`,
  eqNoArray: (trail: string, key: string) => `${trail}的 ${key}：等值位不接受数组（数组只能出现在 in 里）`,
  inNeedsArray: (trail: string, key: string) => `${trail}的 ${key}.in：值必须是数组`,
  opNoArray: (trail: string, key: string, op: string) => `${trail}的 ${key}.${op}：不接受数组`,
  whenSourceUnknown: (cls: string, src: string) => `when 规则指向不存在的源条目：${cls} 没有 ${src}`,
  propNotDerived: (prop: string) => `属性不是派生的：${prop}`,
  whenFilterSpecial: (key: string) => `when 下的过滤不支持 ${key}`,
  preKeyOnly: (key: string) => `${key} 只属于前置，查询过滤不支持`,
  filterPropUnknown: (cls: string, key: string) => `过滤里的名字对不上配置：${cls}.${key}`,
  transitionPropNotWhen: (prop: string) => `transition.property 不是 when 派生：${prop}`,
  stageNotInRules: (from: string, to: string) => `派生规则里找不到阶段 ${from} / ${to}`,
  linkNameUnknown: (cls: string, name: string) => `关系名对不上配置：${cls} 出发没有 ${name}`,
  noIdentity: "类没有 identity，源条目也没有 key",
  keyPropUnmapped: (keyProp: string) => `源条目的 fields 里没有对齐属性 ${keyProp}`,
  classPropUnknown: (prop: string) => `类上没有属性：${prop}`,
  transitionNoTargetFilter: (link: string) => `转化关系不支持目标侧过滤：${link}`,
  propUnknown: (cls: string, p: string) => `名字对不上配置：${cls}.${p}`,
  operatorUnknown: (op: string) => `未知运算符：${op}`,
  aggregateWithExpand: "聚合与展开不能同给：分组统计不携带逐个体明细",
  expandTooDeep: "展开最多三层",
  orderPropUnknown: (prop: string) => `order 里的名字对不上配置：${prop}`,
  transitionNoNestedExpand: (relation: string) => `转化关系不支持嵌套展开：${relation}`,
  propertiesPropUnknown: (cls: string, p: string) => `properties 里的名字对不上配置：${cls}.${p}`,
  aggregateUnknown: (op: string) => `未知聚合：${op}`,
  expandFilterConflict: (relation: string, k: string) => `展开 ${relation} 的目标侧过滤 ${k} 与配对字段冲突`,
  filterConflictsPair: (k: string, link: string) => `目标侧过滤 ${k} 与关系 ${link} 的配对字段冲突`,

  // 基础设施 infra（连接生命周期、驱动注册表、工作空间、LLM 槽位）
  sqliteNeedsPath: "sqlite 连接必须给文件路径（db_name）",
  sqliteFileMissing: (p: string) => `sqlite 文件不存在：${p}`,
  sqlNeedsHost: "mysql/pg 连接必须给 host 与 db_name",
  demoSourceName: (name: string) => `${name} 是内置演示源，换个名字`,
  connectFailed: (detail: string) => `连不上：${detail}`,
  connectionNotFoundBuiltin: (name: string) => `连接不存在：${name}（内置演示源不能删）`,
  connectionInUsePublished: (name: string) => `连接 ${name} 仍被已发布本体引用，先改本体再删`,
  connectionUnregistered: (connection: string) => `未注册的连接：${connection}`,
  introspectUnsupported: (connection: string) => `连接 ${connection} 不支持内省`,
  sampleUnsupported: (connection: string) => `连接 ${connection} 不支持采样`,
  wsNameBad: (ws: string) => `空间名不合法：${ws}`,
  wsNameBadFull: (name: string) => `空间名必须是小写字母/数字/中划线/下划线，字母开头：${name}`,
  wsExists: (name: string) => `空间已存在：${name}`,
  cannedWsOnly: "离线回退只覆盖 test 演示空间的问法：配 OPENAI_API_KEY，或到 test 演示空间问",
  cannedScriptOnly: "离线回退只覆盖演示剧本的问法：配 OPENAI_API_KEY，或到 test 演示空间问",
  openaiModelMissing: "OPENAI_MODEL 未设置：接真模型必须显式指定模型名",

  // 元库（meta/stores：工作副本行读回）
  workingPackBadJson: "工作副本读不回来：不是合法 JSON",

  // 路由（app/api：请求体、zod 形状标签、respond 第二参、refine 消息）
  bodyNotJson: "请求体不是合法 JSON",
  questionNotFound: "没有这条问题",
  zodRequestShape: "请求形状不合法",
  zodOpShape: "操作形状不合法",
  zodConnectionShape: "连接形状不合法",
  zodConfigShape: "配置结构不合法",
  connectionNameBad: "连接名必须是小写字母/数字/下划线",
  pairSelfOverlap: "自己和自己不算疑似重复",
  pairSelfDecide: "class_a 与 class_b 不能是同一个类",
} as const;
