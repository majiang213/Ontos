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
export class WorkspaceReject extends Error {}

/* ---------- Result：边界入口的统一返回 ----------
   数字 code 参考 HTTP 状态码（成功 200 / 失败 400、422），与路由返回的 HTTP 状态必须一致（rejectRes 原样用）；
   message 是完整准确文案（失败 = MSG 原文，成功 = 操作结果描述，也在 MSG）。
   没有 ok 布尔字段：判别联合按 code 收窄（code === 200 时 value 类型安全）。
   意外异常不进 Result，原样 throw（respond 兜 500「内部错误」）。 */

export type Result<T> =
  | { code: 200; message: string; value: T }
  | { code: 400 | 422; message: string };

/** 域拒绝 → Result code 的唯一映射：连接类 bad_request=400，其余一律 422；不认识的异常返回 null（原样上抛 = 500）。只在 toResult 里用。 */
function codeOf(e: unknown): 400 | 422 | null {
  if (e instanceof ConnectionReject) return e.kind === "bad_request" ? 400 : 422;
  if (e instanceof EngineReject || e instanceof DraftReject || e instanceof WorkspaceReject) return 422;
  return null;
}

/** 业务拒绝落服务端日志（message + 堆栈）：拒绝是定案不是吞错，但排查要能看见是哪条规则、哪一步拒的。
 *  REST 与 MCP 的收尾（toResult / respond / internalError / mcp 路由的 catch）都走这一处，不各写一遍。 */
export function logReject(e: unknown): void {
  const message = e instanceof Error ? e.message : String(e);
  const stack = e instanceof Error && e.stack ? `\n${e.stack}` : "";
  console.error(`[ontos] 业务拒绝：${message}${stack}`);
}

/** 边界入口的统一收尾（唯一出处）：跑 fn，成功包 200 + 成功文案；域拒绝按 codeOf 收成失败 Result；
 *  意外异常原样上抛（不进 Result，respond 兜 500「内部错误」）。各入口不再自写 try/catch 阶梯。 */
export async function toResult<T>(fn: () => Promise<T>, ok: (value: T) => string): Promise<Result<T>> {
  try {
    const value = await fn();
    return { code: 200, message: ok(value), value };
  } catch (e) {
    const code = codeOf(e);
    if (code !== null) {
      logReject(e);
      return { code, message: e instanceof Error ? e.message : String(e) };
    }
    throw e;
  }
}

/* ---------- 用户看得见的错误文案（唯一出处） ----------
   按域分节：草稿编辑 op / 引用 trail / 校验 / 执行 / 查询 / 基础设施 / 路由。
   规则：文案字节级稳定（测试按子串断言）；新增报错一律加在这里，不在调用点现写。 */

export const MSG = {
  // 草稿编辑 op（draft/ops、editDraft、versions、canvasPack）
  classNotFound: (name: string) => `类不存在：${name}`,
  classExists: (name: string) => `类已存在：${name}`,
  classNameBad: (name: string) => `类名必须是小写字母/数字/下划线，字母开头：${name}`,
  classNotFoundReplace: (name: string) => `类不存在：${name}，新建请用 import_objects`,
  propNameBad: "字段名必须是小写字母/数字/下划线，字母开头",
  propExists: (name: string) => `字段已存在：${name}`,
  propNotFound: (name: string) => `字段不存在：${name}`,
  propNotOnClass: (cls: string, prop: string) => `${cls} 上没有字段 ${prop}`,
  propIdentityNoDelete: "唯一键不能直接删，先换一个",
  propDerivedNoIdentity: "派生字段不能当唯一键",
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
  linkNoPairProps: "新端点上没有任何字段，配不出配对字段",
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
  trailDerived: (cls: string, prop: string) => `派生字段 ${cls}.${prop}`,
  trailDerivedProp: (prop: string) => `派生字段 ${prop}`,
  trailAction: (cls: string, act: string) => `动作 ${cls}.${act}`,

  tableNotFound: (connection: string, table: string) => `表不存在：${connection}.${table}`,

  // 校验 validate 与取值规约（draft/validate、schema/spec）——一律「配置不合法：」前缀
  cfgLinkUnknown: (trail: string, ln: string) => `配置不合法：${trail} 引用了不存在的关系 ${ln}`,
  cfgFilterPropUnknown: (trail: string, cls: string, k: string) => `配置不合法：${trail} 过滤了 ${cls} 上不存在的字段 ${k}`,
  cfgIdentityMissing: (cls: string, identity: string) => `配置不合法：${cls} 的 identity 指向不存在的字段 ${identity}`,
  cfgIdentityDerived: (cls: string, identity: string) => `配置不合法：${cls} 的 identity 指向派生字段 ${identity}`,
  cfgNoRowKey: (cls: string, src: string) => `配置不合法：${cls}.${src} 没有认行依据（类无 identity，条目也无 key）`,
  cfgFieldsMissingKey: (cls: string, src: string, keyProp: string) => `配置不合法：${cls}.${src} 的 fields 缺对齐字段 ${keyProp}`,
  cfgDerivedInFields: (cls: string, src: string, prop: string) => `配置不合法：派生字段不得进 fields（${cls}.${src} 的 ${prop}）`,
  cfgFieldsUnknownProp: (cls: string, src: string, prop: string) => `配置不合法：${cls}.${src} 的 fields 指向不存在的字段 ${prop}`,
  cfgDerivedUnknownSource: (cls: string, prop: string, src: string) => `配置不合法：${cls}.${prop} 的派生规则指向不存在的源条目 ${src}`,
  cfgDerivedUnmappedProp: (cls: string, prop: string, src: string, k: string) => `配置不合法：${cls}.${prop} 的派生规则在 ${src} 上过滤未映射的字段 ${k}`,
  cfgDerivedUnknownProp: (cls: string, prop: string, c: string, k: string) => `配置不合法：${cls}.${prop} 的派生规则过滤了 ${c} 上不存在的字段 ${k}`,
  cfgDerivedUnknownLink: (cls: string, prop: string, ln: string) => `配置不合法：${cls}.${prop} 的派生规则引用了不存在的关系 ${ln}`,
  cfgDerivedSpecialKey: (cls: string, prop: string, src: string, k: string) => `配置不合法：${cls}.${prop} 的派生规则里 ${src} 的过滤不支持 ${k}`,
  cfgLinkEndMissing: (link: string, end: string) => `配置不合法：关系 ${link} 的端点 ${end} 不存在`,
  cfgMatchPropMissing: (link: string, side: string) => `配置不合法：关系 ${link} 的 match 指向不存在的字段 ${side}`,
  cfgMatchPropDerived: (link: string, side: string) => `配置不合法：关系 ${link} 的 match 指向派生字段 ${side}`,
  cfgTransitionNotWhen: (link: string, from: string, prop: string) => `配置不合法：关系 ${link} 的 transition.property 不是 when 派生（${from}.${prop}）`,
  cfgTransitionValues: (link: string, from: string, to: string) => `配置不合法：关系 ${link} 的 transition 阶段值不在派生规则里（${from} / ${to}）`,
  cfgEffectClassMissing: (cls: string, act: string, object: string) => `配置不合法：${cls}.${act} 的效应指向不存在的类 ${object}`,
  cfgEffectPropMissing: (cls: string, act: string, object: string, prop: string) => `配置不合法：${cls}.${act} 的效应写了不存在的字段 ${object}.${prop}`,
  cfgEffectPropDerived: (cls: string, act: string, object: string, prop: string) => `配置不合法：${cls}.${act} 的效应写了派生字段 ${object}.${prop}`,
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
  cfgValueGenerated: (where: string, detail: string) => `配置不合法：${where} 的 from: generated 只许用在 create 效应且目标字段带 generate 列表：${detail}`,
  cfgValueUnknown: (where: string, detail: string) => `配置不合法：${where} 的取值来源不认识：${detail}`,
  cfgOperandArrayLiteral: (where: string) => `配置不合法：${where} 的数组元素只许是字面量`,
  cfgConclusionDupClass: "配置不合法：类与类结论的 classes 里有重复的类名",
  cfgConclusionOverlapNoShared: "配置不合法：部分重叠必须写 shared（上位对象）",
  cfgConclusionSharedInClasses: "配置不合法：部分重叠的 shared 不能写进 classes",
  cfgConclusionSharedOnlyOverlap: "配置不合法：只有部分重叠能写 shared",
  cfgConclusionClassMissing: (kind: string, name: string) => `配置不合法：类与类结论 ${kind} 点到了不存在的类 ${name}`,
  cfgConclusionSharedMissing: (name: string) => `配置不合法：部分重叠的上位对象 ${name} 不存在`,

  // 动作执行（features/action，运行期拒绝，被 runAction 收成 stage=effect/pre 的结果）
  linkOnlyTransition: (link: string) => `link 只用于转化关系：${link}`,
  transitionNotOnClass: (link: string, cls: string) => `转化关系 ${link} 不在 ${cls} 上`,
  effectIdentify: (object: string) => `认人必须写明：${object} 缺 identity 或 filter`,
  effectNoTarget: (object: string) => `效应找不到对象：${object}`,
  effectPropUnknown: (cls: string, prop: string) => `效应里的名字对不上配置：${cls}.${prop}`,
  derivedNoWrite: (cls: string, prop: string) => `派生字段不能写入：${cls}.${prop}`,
  noSourceCarries: (cls: string) => `没有源能承接 ${cls} 的全部所赋字段`,
  actionNotOnClass: (object: string, action: string) => `${object} 上没有动作：${action}`,
  preNotSatisfied: "前置不满足",
  axiomConflict: (name: string, prop: string) => `违反公理 ${name}：${prop} 被赋两个值`,
  noSourceCarriesChange: "没有来源能承接这次变化（字段没映射，或源库里没这行）",
  targetNoSourceCarries: (key: string) => `个体 ${key} 没有来源能承接这次变化（字段没映射，或源库里没这行）`,
  targetValueFailed: (key: string, detail: string) => `个体 ${key} 取值失败：${detail}`,
  updateNoHit: "条件更新未命中（行可能已被并发改动）",
  noteAlreadyTarget: "已是目标值，没重复写",
  noteAlreadyInserted: "已有这行，没重复插",
  notifyDeferred: "告知本期预留，引擎不执行外发（机制见《ontos-article.md》§6.5）",
  notifyDeferredWithFailure: "告知本期预留，引擎不执行外发；有投影失败，事件按计划生成，与实际存在可能有差（§6.5）",
  notifyBuildFailed: (detail: string) => `变更事件生成失败：${detail}`,
  noWritableProps: "该类没有可写字段（唯一键与派生字段不可写）",

  // 裁决（adjudication：资格闸与定案应用；applyVerdict 的 Error 会被 mutateDraft 包装成用户可见拒绝）
  classPairNotFound: (a: string, b: string) => `类不存在：${a} 或 ${b}`,
  stageNeedsTwoSources: "阶段裁决需要两个不同的源条目",
  stageStatusClash: (a: string) => `阶段裁决需要立派生字段 status，但 ${a} 上已有同名字段——先把它改名或删掉`,
  stageLinkNameClash: (name: string) => `关系名 ${name} 已存在——换个阶段名再裁`,
  stageActionNameClash: (name: string) => `动作名 ${name} 已存在——换个阶段名再裁`,

  pairNoSources: "无源对象不算疑似重复（先给它挂来源）",
  pairNoIdentity: "两边对不上号：有类没设唯一键",
  identityColumnTooBig: (cls: string, max: number) => `${cls} 的唯一键列超过 ${max} 行，交集算不了（先收窄范围）`,
  decideClassMissing: "类不存在，先刷新画布",
  decideNoSources: "无源对象不进裁决（先给它挂来源）",

  // 查询（features/query：表达式求值、过滤形状、个体读取、投影/聚合/展开）
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
  generatedUnsupported: (prop: string) => `该路径不支持 from: generated（字段 ${prop}：发号只在 create 投影里可用）`,
  valueSourceUnknown: (detail: string) => `无法识别的取值来源：${detail}`,
  noGenerate: (cls: string, prop: string) => `${cls}.${prop} 没有 generate`,
  noSnowflake: "运行环境没注入雪花号生成器，generate 的 snowflake 项算不了",
  noClock: "运行环境没注入时钟，日期表达式算不了",
  noUuid: "运行环境没注入随机源，uuid 生成不了",
  generateItemUnknown: (detail: string) => `无法识别的 generate 项：${detail}`,
  operandMissing: (prop: string) => `操作数取不到值：${prop}`,
  operandUnknown: (detail: string) => `无法识别的操作数：${detail}`,
  linkNestTooDeep: (trail: string) => `${trail}：$link 嵌套最多三层`,
  eqNoArray: (trail: string, key: string) => `${trail}的 ${key}：等值位不接受数组（数组只能出现在 in 里）`,
  inNeedsArray: (trail: string, key: string) => `${trail}的 ${key}.in：值必须是数组`,
  opNoArray: (trail: string, key: string, op: string) => `${trail}的 ${key}.${op}：不接受数组`,
  whenSourceUnknown: (cls: string, src: string) => `when 规则指向不存在的源条目：${cls} 没有 ${src}`,
  propNotDerived: (prop: string) => `字段不是派生的：${prop}`,
  whenFilterSpecial: (key: string) => `when 下的过滤不支持 ${key}`,
  preKeyOnly: (key: string) => `${key} 只属于前置，查询过滤不支持`,
  filterPropUnknown: (cls: string, key: string) => `过滤里的名字对不上配置：${cls}.${key}`,
  transitionPropNotWhen: (prop: string) => `transition.property 不是 when 派生：${prop}`,
  stageNotInRules: (from: string, to: string) => `派生规则里找不到阶段 ${from} / ${to}`,
  linkNameUnknown: (cls: string, name: string) => `关系名对不上配置：${cls} 出发没有 ${name}`,
  noIdentity: "类没有 identity，源条目也没有 key",
  keyPropUnmapped: (keyProp: string) => `源条目的 fields 里没有对齐字段 ${keyProp}`,
  classPropUnknown: (prop: string) => `类上没有字段：${prop}`,
  transitionNoTargetFilter: (link: string) => `转化关系不支持目标侧过滤：${link}`,
  propUnknown: (cls: string, p: string) => `名字对不上配置：${cls}.${p}`,
  operatorUnknown: (op: string) => `未知运算符：${op}`,
  aggregateWithExpand: "聚合与展开不能同给：分组统计不携带逐个体明细",
  expandTooDeep: "展开最多三层",
  orderPropUnknown: (prop: string) => `order 里的名字对不上配置：${prop}`,
  transitionNoNestedExpand: (relation: string) => `转化关系不支持嵌套展开：${relation}`,
  propertiesPropUnknown: (cls: string, p: string) => `properties 里的名字对不上配置：${cls}.${p}`,
  aggregateUnknown: (op: string) => `未知聚合：${op}`,
  filterConflictsPair: (link: string, k: string) => `目标侧过滤 ${k} 与关系 ${link} 的配对字段冲突`,

  // 基础设施 infra（连接生命周期、驱动注册表、工作空间、LLM 槽位）
  sqliteNeedsPath: "sqlite 连接必须给文件路径（db_name）",
  sqliteFileMissing: (p: string) => `sqlite 文件不存在：${p}`,
  sidecarCommentsUnreadable: (p: string) => `注释文件读不出：${p}.comments.json——修好或删掉这个文件再保存`,
  sqlNeedsHost: "mysql/pg 连接必须给 host 与 db_name",
  demoSourceName: (name: string) => `${name} 是内置演示源，换个名字`,
  connectFailed: "连不上：请检查地址、端口、账号与库名（驱动原始报错含连接细节，不原样出网）",
  connectedNoTables: "连上了，但库里没有表",
  connectionNotFoundBuiltin: (name: string) => `连接不存在：${name}（内置演示源不能删）`,
  connectionInUsePublished: (name: string) => `连接 ${name} 仍被已发布本体引用，先改本体再删`,
  connectionUnregistered: (connection: string) => `未注册的连接：${connection}`,
  introspectUnsupported: (connection: string) => `连接 ${connection} 不支持读取表结构`,
  sampleUnsupported: (connection: string) => `连接 ${connection} 不支持采样`,
  workspaceNameBad: (name: string) => `空间名必须是小写字母/数字/中划线/下划线，字母开头：${name}`,
  workspaceExists: (name: string) => `空间已存在：${name}`,
  cannedWsOnly: "离线回退只覆盖 test 演示空间的问法：配 OPENAI_API_KEY，或到 test 演示空间问",
  cannedScriptOnly: "离线回退只覆盖演示剧本的问法：配 OPENAI_API_KEY，或到 test 演示空间问",
  openaiModelMissing: "OPENAI_MODEL 未设置：接真模型必须显式指定模型名",
  noJsonInModelOutput: "模型产出里没有 JSON 对象",
  noSuchConnection: "没有这个连接",
  connectionReadFailed: "连接失败或读取表结构失败",

  // 元库（meta/stores：工作副本行读回；meta/datasource：DSN 选方言）
  workingPackBadJson: "工作副本读不回来：不是合法 JSON",
  metaDsnUnknown: (scheme: string) =>
    scheme
      ? `ONTOS_META_DSN 只认 mysql:// 与 postgres://（或 postgresql://），不认 ${scheme}`
      : "ONTOS_META_DSN 只认 mysql:// 与 postgres://（或 postgresql://）",

  // 路由（app/api：请求体、zod 形状标签、respond 第二参、refine 消息）
  bodyNotJson: "请求体不是合法 JSON",
  questionNotFound: "没有这条问题",
  zodRequestShape: "请求形状不合法",
  zodOpShape: "操作形状不合法",
  zodConnectionShape: "连接形状不合法",
  zodConfigShape: "配置结构不合法",
  connectionNameBad: "连接名必须是小写字母/数字/下划线",
  pairSelfOverlap: "自己和自己不算疑似重复",
  updatePropsNoEmpty: "update.properties 不能为空（空 SET 不是合法 SQL）",
  matchXorTransition: "match 与 transition 必须且只能写一种",
  metricSingleKey: "每条聚合只写一个键",
  metricDuplicate: "聚合指标不能重复",
  orderSingleKey: "order 只支持单键",
  // 验收跑批的 detail 通道（features/acceptance/questions 的 checkExpected 白话原因）
  expectRowsMismatch: (n: number, got: number) => `期望 ${n} 行，实得 ${got} 行`,
  expectTotalMismatch: (n: number, got: number) => `期望合计 ${n}，实得 ${got}`,
  expectTruncated: (limit: number, n: number) => `查询带了截断 limit=${limit}，不能和期望 ${n} 比`,
  expectMultiMetric: (count: number) => `聚合带了 ${count} 条指标，没法和单个期望数字比——一条问题只留一条指标`,
  expectFieldMiss: (field: string, value: string, got: number) => `没有一行的「${field}」等于「${value}」（实查 ${got} 行）`,
  internalError: "内部错误",
  unauthorizedWrite: "未授权：写操作需要有效的令牌",

  // 表单（前端 actionView 经纯叶子 import 共用；动作表单的行级校验文案）
  formNameBad: "名字必须是小写字母/数字/下划线，字母开头",
  formPreRowNoProp: "前置里有一行没选字段",
  formPreRowNoLink: "前置里有一行没选关系",
  formUpdateRowNoProp: "「把字段写成某值」里有一行没选字段",
  formUpdateNoProps: "「把字段写成某值」至少选一行字段",
  formLinkNoLink: "「转化」没选关系",
  formCreateNoObject: "「新生一个对象」没选对象",
  formCreateRowNoProp: "「新生一个对象」里有一行没选字段",
  formCreateNoProps: "「新生一个对象」至少填一行字段",
  formNoEffect: "「做完会」至少要有一条",
  rpcBadRequest: "不是合法请求：需要 { method, params?, id? }",
  rpcUnknownMethod: (method: string) => `未知方法：${method}`,
  rpcMissingToolName: "tools/call 缺 params.name",
  rpcUnknownTool: (name: string) => `未知工具：${name}`,
  rpcNoSpace: "这个工具不接受 space",
  rpcSpaceValues: "space 只认 published 或 draft",
  pairSelfDecide: "class_a 与 class_b 不能是同一个类",
  pairSelfAdvise: "自己和自己不用再建议",

  // Result 成功提示（边界入口的 message：白话、准确；失败文案在上面各节）
  resultQueryRows: (n: number) => `查到 ${n} 行`,
  resultDraftSaved: "已保存到工作副本",
  resultPublished: (v: number) => `已发布 v${v}`,
  resultDiscarded: "已放弃未发布的改动",
  resultRolledBack: (v: number) => `已回到 v${v}`,
  resultDecided: (label: string) => `已记录裁决：${label}`,
  resultOverlap: (rate: number) => `交集率 ${Math.round(rate * 100)}%`,
  resultCandidates: (n: number) => `找到 ${n} 个疑似重复`,
  resultPairAdvice: (label: string) => `建议「${label}」`,
  resultRunDone: (n: number) => `跑批完成：${n} 条`,
  resultProposed: (n: number) => `生成 ${n} 个对象建议`,
  resultConnectionSaved: "连接已保存",
  resultConnectionDropped: "连接已删除",
  resultWorkspaceCreated: (name: string) => `已创建空间 ${name}`,
  resultWorkspaces: (n: number) => `共 ${n} 个工作空间`,
} as const;
