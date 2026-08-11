"use client";

// ============================================================
// 模拟 Agent —— PROTOTYPE 专用，整体是"LLM agent loop 的占位"。
// MVP 里这个文件换成 /api/chat：LLM 决定调哪些工具（协议不变）；
// 这里用规则模拟"理解意图 → 调工具 → 组织回答"，流程不定死。
// 硬规则（产品纪律，与路径无关）：
//   ① LLM/Agent 只产草稿，不落库；② 合并裁决权必须在人；
//   ③ 只读源库，业务数据不落地。
// ============================================================
import { useRef, useState } from "react";
import { load as parseYaml } from "js-yaml";
import { toYaml } from "@/lib/ontology";

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface Msg {
  id: string;
  role: "agent" | "user";
  kind: "text" | "schema" | "drafts" | "decision" | "published" | "generated" | "answer";
  text?: string;
  payload?: any;
}
export interface Workspace {
  type: "welcome" | "schema" | "drafts" | "merged" | "code" | "answer" | "ontology";
  data?: any;
}

// 用随机 id，避免 HMR 重置计数器导致消息 key 冲突
const nid = () => (typeof crypto !== "undefined" && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const REL_NAME: Record<string, string> = { "①": "完全等价", "②": "部分重叠", "③": "生命周期阶段", "⑤": "仅名字像" };
export const pairKey = (e: any) =>
  e.pair.includes("candidate") ? "person" : e.pair.includes("department ↔ hr") ? "department" : "position";
const PAIR_WORDS: Record<string, RegExp> = {
  person: /人员|候选人|员工/,
  department: /部门/,
  position: /职位|岗位|JD|编制/i,
};

// 问数 → 命名 API（MVP 里由 LLM 命名并注册）
function apiNameFor(q: string, n: number): string {
  if (/转正/.test(q)) return "list_converted_persons";
  if (/在职/.test(q)) return "list_active_persons";
  if (/候选人/.test(q)) return "list_candidates";
  return `custom_query_${n + 1}`;
}

// 工作空间：每个空间有自己的数据源/本体/产物/对话，可切换、可新建
function emptyData() {
  return {
    schemas: null as any,
    drafts: null as any,
    draftsConfirmed: false,
    evidence: null as any[] | null,
    decisions: {} as Record<string, string>,
    merged: null as any,
    artifacts: null as any,
    apis: [] as any[], // 问数沉淀的 API 资产
    connectDone: false,
    version: 0,
    history: [] as any[], // 发布历史：每次发布/手动编辑/回滚追加一个版本快照
    lastQuery: "" as string,
    queryCount: 0,
    _all: null as any,
    _draftAll: null as any,
  };
}
function makeWelcome(): Msg {
  return {
    id: nid(),
    role: "agent",
    kind: "text",
    text: "我是 Ontos（当前是规则模拟，正式版由 LLM 驱动）。我把老数据库逆向成业务本体，整合多源同义对象，生成新系统——全程只读源库，不迁移数据。\n\n构建流程顺序：连接→建模→整合→发布，发布成功即自动生成新系统。只有一件事必须你来——跨源对象怎么合并，裁决权在你。对话在顶部「对话」页，随时可去。",
    payload: { hero: true, suggestions: ["交集率是什么意思？", "本体是什么？"] },
  };
}

function makeChatWelcome(): Msg {
  return {
    id: nid(),
    role: "agent",
    kind: "text",
    text: "我是对话 Agent（规则模拟）。本体发布后，直接用业务语言提问：我把问题编译成结构化查询——**每次问数都会生成一个命名 API 并保存**，问过的问题直接复用已保存的 API，不重新生成。全程只读源库，答案带取数路径，不落库。",
    payload: { suggestions: ["查所有从候选人转正的员工及其部门", "还有多少候选人？"] },
  };
}

// 演示环境的预填连接配置；正式版这里驱动真实的 connector 配置向导
export const CONNS = [
  { connection: "recruiting", kind: "mysql", label: "MySQL", host: "127.0.0.1", port: "3306", database: "recruiting", user: "ro_recruiting", password: "demo-pass" },
  { connection: "hr", kind: "pg", label: "PostgreSQL", host: "127.0.0.1", port: "5432", database: "hr", user: "ro_hr", password: "demo-pass" },
];

// 第 N 个表单用什么配置：前两个是演示后端；超出后复用演示后端并改名（仅演示）
// 候选对 "recruiting.candidate ↔ hr.employee" 两端各自的源（backend 名）
function pairBackendsOf(pair: string): string[] {
  return pair.split("↔").map((s) => s.trim().split(".")[0]);
}
// 候选对两端的 "conn.table"
function pairEndpointsOf(pair: string): string[] {
  return pair.split("↔").map((s) => s.trim());
}
// 已加入画布的表（草稿对象的来源表，忽略对象不算）
function stagedTableSet(s: any): Set<string> {
  return new Set(
    (s.drafts ?? []).flatMap((d: any) =>
      Object.values<any>(d.ontology.object_types)
        .filter((o) => !o._ignored)
        .flatMap((o) => o.sources.map((src: any) => `${src.connection}.${src.table}`)),
    ),
  );
}
// 候选对两端的表都已加入画布才可裁决
function pairStaged(s: any, pair: string): boolean {
  const st = stagedTableSet(s);
  return pairEndpointsOf(pair).every((t) => st.has(t));
}

export function connFor(idx: number) {
  if (idx < CONNS.length) return { ...CONNS[idx], backend: CONNS[idx].connection, tables: 3, reused: false };
  const base = CONNS[idx % CONNS.length];
  const n = Math.floor(idx / CONNS.length) + 1;
  return { ...base, connection: `${base.connection}_${n}`, backend: base.connection, tables: 3, reused: true };
}

export function useMockAgent() {
  // 每个工作空间：独立数据 + 两个页面（本体构建 / 问数）；问数页可新建多个会话
  type ChatSession = { id: string; title: string; msgs: Msg[] };
  type Bucket = {
    data: any;
    activeConv: string;
    flowMsgs: Msg[];
    chats: ChatSession[];
    activeChatId: string;
    panel: Workspace;
    wizardStep?: string;
  };
  const buckets = useRef<Record<string, Bucket>>({});
  if (!buckets.current.demo) {
    buckets.current.demo = {
      data: emptyData(),
      activeConv: "flow",
      flowMsgs: [makeWelcome()],
      chats: [{ id: "c1", title: "新会话", msgs: [makeChatWelcome()] }],
      activeChatId: "c1",
      panel: { type: "welcome" },
    };
  }
  const [wsList, setWsList] = useState([{ id: "demo", name: "演示工作空间" }]);
  const [activeWs, setActiveWs] = useState("demo");
  const store = useRef(buckets.current.demo.data);
  const [activeConv, setActiveConv] = useState("flow");
  const [activeChatId, setActiveChatId] = useState(buckets.current.demo.activeChatId);
  const [msgs, setMsgs] = useState<Msg[]>(buckets.current.demo.flowMsgs);
  const [ws, setWs] = useState<Workspace>(buckets.current.demo.panel);
  const [wizardStep, setWizardStep] = useState("connect"); // 初始化向导当前查看的步骤
  const [busy, setBusy] = useState(false);
  const [, forceRender] = useState(0);

  const CONVS = [
    { id: "flow", title: "本体构建" },
    { id: "chat", title: "对话" },
  ];

  function switchConv(id: string) {
    if (id === activeConv) return;
    const b = buckets.current[activeWs];
    b.activeConv = id;
    setActiveConv(id);
    setMsgs(id === "flow" ? b.flowMsgs : b.chats.find((c) => c.id === b.activeChatId)?.msgs ?? []);
    setDecisionOpen(false);
    setConnectFlow(null);
  }

  // 新建问数会话；返回会话 id
  function newChat(): string {
    const b = buckets.current[activeWs];
    const id = `c${Date.now()}`;
    b.chats.push({ id, title: "新会话", msgs: [makeChatWelcome()] });
    b.activeChatId = id;
    setActiveChatId(id);
    setMsgs(b.chats[b.chats.length - 1].msgs);
    rerender();
    return id;
  }

  function switchChat(id: string) {
    const b = buckets.current[activeWs];
    const c = b.chats.find((x) => x.id === id);
    if (!c || id === b.activeChatId) return;
    b.activeChatId = id;
    setActiveChatId(id);
    setMsgs(c.msgs);
    rerender();
  }

  function switchWorkspace(id: string) {
    if (id === activeWs || !buckets.current[id]) return;
    // 先把当前会话的最新消息写回原空间
    const cur = buckets.current[activeWs];
    if (cur.activeConv === "flow") cur.flowMsgs = msgs;
    else {
      const c = cur.chats.find((x) => x.id === cur.activeChatId);
      if (c) c.msgs = msgs;
    }
    const b = buckets.current[id];
    store.current = b.data;
    setActiveConv(b.activeConv);
    setActiveChatId(b.activeChatId);
    setMsgs(b.activeConv === "flow" ? b.flowMsgs : b.chats.find((c) => c.id === b.activeChatId)?.msgs ?? []);
    setWs(b.panel);
    setWizardStep(b.wizardStep ?? "connect");
    setActiveWs(id);
    setDecisionOpen(false);
    setConnectFlow(null);
    setBusy(false);
  }

  function newWorkspace() {
    const id = `ws${Date.now()}`;
    buckets.current[id] = {
      data: emptyData(),
      activeConv: "flow",
      flowMsgs: [makeWelcome()],
      chats: [{ id: "c1", title: "新会话", msgs: [makeChatWelcome()] }],
      activeChatId: "c1",
      panel: { type: "welcome" },
    };
    setWsList((l) => [...l, { id, name: `工作空间 ${wsList.length}` }]);
    switchWorkspace(id);
  }

  // UI 点击发起的执行整体静音——对话只承载真实打字的交流
  const quiet = useRef(false);
  const uiBusy = useRef(false);
  const push = (m: Omit<Msg, "id">) => {
    if (quiet.current) return;
    setMsgs((xs) => {
      const next = [...xs, { ...m, id: nid() }];
      const b = buckets.current[activeWs];
      if (b.activeConv === "flow") {
        b.flowMsgs = next;
      } else {
        const c = b.chats.find((x) => x.id === b.activeChatId);
        if (c) {
          c.msgs = next;
          // 新会话以第一句提问命名
          if (c.title === "新会话" && m.role === "user" && m.text?.trim()) c.title = m.text.trim().slice(0, 16);
        }
      }
      return next;
    });
  };
  const say = (text: string, extra?: any) => push({ role: "agent", kind: "text", text, payload: extra });
  const rerender = () => forceRender((n) => n + 1);

  // ---------- 工具（调真 API）----------
  async function tConnect() {
    if (store.current.schemas) return false;
    store.current.schemas = await (await fetch("/api/introspect")).json();
    store.current.connectDone = true;
    push({
      role: "agent",
      kind: "schema",
      text: "用预置的只读配置把两个库连上了（跳步时免表单）。6 张表，结构和采样在右边。注意 candidate.mobile 是 +86 带连字符的脏格式——后面算交集前要先归一化。",
      payload: { sources: store.current.schemas },
    });
    return true;
  }
  async function tDraft() {
    const s = store.current;
    if (s.drafts) return false;
    const all = await (await fetch("/api/draft")).json();
    // 按已配置的连接生成草稿；复用后端的连接克隆草稿并改名
    s.drafts = (s.schemas ?? []).map((sv: any) => {
      const hit = all.find((d: any) => d.connection === sv.connection);
      if (hit) return hit;
      const base = all.find((d: any) => d.connection === sv.backend) ?? all[0];
      const ont = JSON.parse(JSON.stringify(base.ontology));
      for (const o of Object.values<any>(ont.object_types)) for (const src of o.sources) src.connection = sv.connection;
      return { connection: sv.connection, ontology: ont, yaml: toYaml(ont) };
    });
    setWizardStep("model");
    push({
      role: "agent",
      kind: "drafts",
      text: `草稿好了：${s.drafts.map((d: any) => `${d.connection} ${Object.keys(d.ontology.object_types).length} 个对象`).join("、")}（右边可切换查看）。我只产草稿，确认权在你。`,
      payload: { drafts: s.drafts },
    });
    return true;
  }
  async function tEvidence() {
    const s = store.current;
    if (s.evidence) return;
    const all = await (await fetch("/api/overlap")).json();
    // 两端源都已连接、且两端的表都已加入画布，才算可裁决的候选对
    const backends = new Set((s.schemas ?? []).map((x: any) => x.backend ?? x.connection));
    s.evidence = all.filter((e: any) => pairBackendsOf(e.pair).every((b) => backends.has(b)) && pairStaged(s, e.pair));
  }
  async function tPublish() {
    const res = await (
      await fetch("/api/merge", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          decisions: store.current.decisions,
          evidence: store.current.evidence,
          drafts: store.current.drafts, // 尊重人工修订与忽略标记
        }),
      })
    ).json();
    store.current.merged = res;
    store.current.version += 1;
    store.current.history.push({
      version: store.current.version,
      yaml: res.yaml,
      ontology: res.ontology,
      merge_decisions: res.merge_decisions,
      at: new Date().toISOString(),
    });
    rerender();
    push({
      role: "agent",
      kind: "published",
      text: `已发布 ontology.yaml v${store.current.version}（右边）。「人员」不再是某个源库的表，而是两个源之上的统一语义。`,
      payload: { yaml: res.yaml },
    });
    // 出码不是独立关卡：首次发布即自动生成；之后本体再变则标过期、手动重出
    if (!store.current.artifacts) await tGenerate();
  }
  async function tGenerate() {
    store.current.artifacts = await (
      await fetch("/api/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ontology: store.current.merged.ontology }),
      })
    ).json();
    store.current.artifactsVersion = store.current.version; // 产物基于的本体版本——不一致即过期
    setWizardStep("generate");
    push({
      role: "agent",
      kind: "generated",
      text: "生成完毕：迁移 DDL（空库起步）、CRUD API、管理界面、字段血缘——右边分栏切换查看。",
      payload: { artifacts: store.current.artifacts },
    });
  }
  async function tQuery(q: string) {
    const s = store.current;
    const existing = s.apis.find((a: any) => a.question === q);
    const res = await (
      await fetch("/api/query", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: q, ontology: s.merged.ontology }),
      })
    ).json();
    if (existing) {
      existing.used += 1;
      res.api = { name: existing.name, reused: true };
    } else {
      const name = apiNameFor(q, s.apis.length);
      s.apis.push({ name, question: q, structured_query: res.structured_query, used: 1, at: new Date().toISOString() });
      res.api = { name, reused: false };
    }
    s.lastQuery = q;
    s.queryCount += 1;
    push({ role: "agent", kind: "answer", payload: res });
    say(
      res.api.reused
        ? `复用已保存的 API \`${res.api.name}\`——问过的问题不重复生成。`
        : `已生成并保存新 API \`${res.api.name}\`，下次同问题直接复用（在「新系统 · 问数 API」台账里）。`,
    );
    rerender();
  }

  // ---------- 工作台操作（真操作，改变状态）----------
  // 单对象 YAML 编辑（对象编辑卡内）：对象名锁定，内容可改；merged 版本 +1 并入历史
  function applyObjectYaml(kind: "draft" | "merged", conn: string | null, objName: string, text: string): string | null {
    let parsed: any;
    try {
      parsed = parseYaml(text);
    } catch (err) {
      return `YAML 语法错误：${String(err).split("\n")[0]}`;
    }
    const obj = parsed?.object_types?.[objName];
    if (!obj) return `缺少 ${objName} 节点——对象名锁定，内容可改`;
    // 归一化，防缺字段崩渲染
    obj.name = objName;
    obj.label = obj.label ?? objName;
    obj.properties = Array.isArray(obj.properties) ? obj.properties : [];
    obj.sources = Array.isArray(obj.sources) ? obj.sources : [];
    const s = store.current;
    const ont = kind === "draft" ? s.drafts?.find((x: any) => x.connection === conn)?.ontology : s.merged?.ontology;
    if (!ont?.object_types?.[objName]) return "对象不存在（可能刚被移除）";
    ont.object_types[objName] = obj;
    if (kind === "draft" && conn) {
      const d = s.drafts.find((x: any) => x.connection === conn);
      d.yaml = toYaml(d.ontology);
    } else if (kind === "merged" && s.merged) {
      s.merged.yaml = toYaml(s.merged.ontology);
      s.version += 1;
      s.history.push({
        version: s.version,
        yaml: s.merged.yaml,
        ontology: structuredClone(s.merged.ontology),
        merge_decisions: s.merged.merge_decisions,
        at: new Date().toISOString(),
        note: `YAML 调整「${obj.label}」`,
      });
    }
    rerender();
    return null;
  }

  // 画布编辑：点节点调整对象（显示名/识别字段/属性增删改）——即改即生效；merged 版本 +1 并入历史
  function updateObject(kind: "draft" | "merged", conn: string | null, objName: string, updated: any): string | null {
    if (!updated?.label?.trim()) return "显示名不能为空";
    const seen = new Set<string>();
    for (const p of updated.properties ?? []) {
      if (!p.name?.trim()) return "字段名不能为空";
      if (seen.has(p.name)) return `字段名重复：${p.name}`;
      seen.add(p.name);
    }
    const s = store.current;
    const ont = kind === "draft" ? s.drafts?.find((x: any) => x.connection === conn)?.ontology : s.merged?.ontology;
    if (!ont?.object_types?.[objName]) return "对象不存在（可能刚被移除）";
    ont.object_types[objName] = { ...ont.object_types[objName], ...updated, name: objName, properties: updated.properties ?? [] };
    if (kind === "draft" && conn) {
      const d = s.drafts.find((x: any) => x.connection === conn);
      d.yaml = toYaml(d.ontology);
    } else if (kind === "merged" && s.merged) {
      s.merged.yaml = toYaml(s.merged.ontology);
      s.version += 1;
      s.history.push({
        version: s.version,
        yaml: s.merged.yaml,
        ontology: structuredClone(s.merged.ontology),
        merge_decisions: s.merged.merge_decisions,
        at: new Date().toISOString(),
        note: `画布调整「${updated.label}」`,
      });
    }
    rerender();
    return null;
  }

  // YAML 手动编辑 → 解析校验 → 即时生效（Ontology-as-Code 的证明）；仅工作台触发，静音
  function applyYaml(kind: "draft" | "merged", conn: string | null, text: string): string | null {
    quiet.current = true;
    try {
      return applyYamlInner(kind, conn, text);
    } finally {
      quiet.current = false;
    }
  }
  function applyYamlInner(kind: "draft" | "merged", conn: string | null, text: string): string | null {
    let parsed: any;
    try {
      parsed = parseYaml(text);
    } catch (err) {
      return `YAML 语法错误：${String(err).split("\n")[0]}`;
    }
    if (!parsed || typeof parsed !== "object" || !parsed.object_types) return "缺少 object_types 根节点";
    // 归一化，防止缺字段导致渲染崩溃
    for (const [key, o] of Object.entries<any>(parsed.object_types)) {
      o.name = o.name ?? key;
      o.label = o.label ?? key;
      o.properties = Array.isArray(o.properties) ? o.properties : [];
      o.sources = Array.isArray(o.sources) ? o.sources : [];
    }
    parsed.link_types = Array.isArray(parsed.link_types) ? parsed.link_types : [];

    const s = store.current;
    if (kind === "draft" && conn && s.drafts) {
      const d = s.drafts.find((x: any) => x.connection === conn);
      if (!d) return "找不到该草稿";
      d.ontology = parsed;
      d.yaml = toYaml(parsed);
      s.drafts = [...s.drafts];
      say(`已保存 ${conn} 草稿（手动编辑）——图与 YAML 已同步更新。这就是 Ontology-as-Code：本体即代码，可 diff、可评审。`);
    } else if (kind === "merged" && s.merged) {
      s.merged.ontology = parsed;
      s.merged.yaml = toYaml(parsed);
      s.version += 1;
      s.history.push({ version: s.version, yaml: s.merged.yaml, ontology: parsed, merge_decisions: s.merged.merge_decisions, at: new Date().toISOString(), note: "手动编辑" });
      say(
        `已保存并发布 v${s.version}（手动编辑）。` +
          (s.artifacts ? "注意：新系统基于旧版本，建议重新生成。" : ""),
      );
    } else {
      return "当前状态不支持该操作";
    }
    rerender();
    return null;
  }

  async function regenerate() {
    if (!store.current.merged) return;
    await tGenerate();
    say("已按当前本体重新生成新系统。", { suggestions: suggestions() });
  }

  async function replay() {
    const q = store.current.lastQuery;
    if (!q) return;
    say(`重放查询：「${q}」`);
    await tQuery(q);
  }

  function reopenDecisions() {
    const s = store.current;
    if (!s.evidence?.length) return; // 无候选对（单源）时没有可重裁的东西
    s.decisions = {};
    setWizardStep("integrate");
    setDecisionOpen(true);
    say("重新裁决：证据不变，在裁决面板里逐对再选一次（重新发布后版本号 +1）。");
  }

  // 重新规划单个对象：只重开它所属那一对的裁决，其余裁决不动
  function replanObject(name: string) {
    const s = store.current;
    const key =
      ["person", "candidate", "employee"].includes(name) ? "person"
        : name.startsWith("department") ? "department"
        : "position";
    const ev = (s.evidence ?? []).filter((e) => pairKey(e) === key);
    if (!ev.length) {
      say("这个对象没有对应的候选对——它是单源对象，可以直接改 YAML 调整。");
      return;
    }
    delete s.decisions[key];
    setWizardStep("integrate");
    say(`重新规划「${PAIR_LABEL[key]}」：只重裁这一对，其余保持不变，重新发布后生效。`);
    setDecisionOpen(true);
  }

  // 草稿确认：人工修订（忽略噪音对象/编辑 YAML）后确认，草稿才成为整合输入
  async function confirmDrafts() {
    const s = store.current;
    if (!s.drafts || s.draftsConfirmed) return;
    s.draftsConfirmed = true;
    await tEvidence(); // 先算证据，再决定去整合步还是发布步
    const n = liveEvidence()?.length ?? 0;
    setWizardStep(n > 0 ? "integrate" : "publish");
    say(
      n > 0
        ? `草稿已确认——${n} 对跨源候选对等你裁决，这是唯一必须你来的环节。`
        : "草稿已确认。单源无候选对，可以直接发布本体。",
    );
    rerender();
  }

  function toggleIgnore(conn: string, objName: string) {
    const s = store.current;
    const d = s.drafts?.find((x: any) => x.connection === conn);
    const o = d?.ontology.object_types[objName];
    if (!o) return;
    o._ignored = !o._ignored;
    d.yaml = toYaml(d.ontology);
    s.drafts = [...s.drafts];
    say(`${o._ignored ? "已忽略" : "已恢复"} ${conn}.${objName}${o._ignored ? "——噪音对象不进本体，合并时也不会带上它" : ""}。`);
    rerender();
  }

  function statusReport() {
    const s = store.current;
    const lines = [
      `源库：${s.schemas ? "已连接 2 个（只读）" : "未连接"}`,
      `本体草稿：${s.drafts ? "已生成（recruiting 3 对象 / hr 3 对象）" : "未生成"}`,
      `裁决：${s.evidence ? `${Object.keys(s.decisions).length}/3 已完成` : "未开始"}`,
      `合并本体：${s.merged ? `已发布 v${s.version}` : "未发布"}`,
      `新系统：${s.artifacts ? "已生成" : "未生成"}`,
      `问数：${s.queryCount} 次（query_logs 全量留痕）`,
      s.merged ? `裁决留痕：${s.merged.merge_decisions?.length ?? 0} 条 merge_decisions（含证据快照）` : "",
    ].filter(Boolean);
    say("当前状态：\n" + lines.join("\n"), { suggestions: suggestions() });
  }

  // ---------- 数据源配置（表单 → 测试 → 保存 → 再添加/继续，数量任意）----------
  const [connectFlow, setConnectFlow] = useState<{
    idx: number;
    tested: boolean;
    testing?: boolean;
    saved: { connection: string; backend: string }[];
    awaiting?: boolean;
  } | null>(null);
  const connectBase = useRef<string[]>([]); // 追加模式：流程开始前已有的连接名

  function startConnectFlow() {
    const existing = (store.current.schemas ?? []).map((x: any) => ({
      connection: x.connection,
      backend: x.backend ?? x.connection,
    }));
    connectBase.current = existing.map((x) => x.connection);
    setConnectFlow({ idx: existing.length, tested: false, saved: existing });
  }

  // 仅在「对话里打字发起」时给的应答；工作台按钮发起时对话保持安静，指引写在表单面板上
  function sayConnectIntro() {
    const has = (store.current.schemas ?? []).length > 0;
    say(
      has
        ? "添加数据源——和已有源同一套规则：只读、永不写源库。配置、测试、保存："
        : "配置数据源——只读账号就够，平台永远不会写源库。演示配置已预填，先测试、再保存；可以只连一个，也可以任意加。",
    );
  }

  async function connectTest() {
    setConnectFlow((f) => (f ? { ...f, testing: true } : f));
    await sleep(700); // 假装在握手
    setConnectFlow((f) => (f ? { ...f, testing: false, tested: true } : f));
  }

  // 选表器开关（画布浮动卡）：保存连接后自动弹出；工具条可再开
  const [pickerOpen, setPickerOpen] = useState(false);

  async function connectSave() {
    const f = connectFlow;
    if (!f || !f.tested) return;
    const s = store.current;
    if (!s._all) s._all = await (await fetch("/api/introspect")).json();
    const cur = connFor(f.idx);
    const saved = [...f.saved, { connection: cur.connection, backend: cur.backend }];
    // 每个已配置连接按其后端生成 schema 条目（演示后端数据按 backend 复用）
    s.schemas = saved.map((sv) => {
      const b = s._all.find((x: any) => x.connection === sv.backend);
      return { ...b, connection: sv.connection, backend: sv.backend };
    });
    setConnectFlow({ ...f, saved, tested: false, awaiting: true });
    setPickerOpen(true); // 连上即选表——用户挑哪些表上画布
    say(`${cur.connection} 已连接，读取到 ${cur.tables} 张表的结构。`);
    rerender();
  }

  function connectAddMore() {
    const f = connectFlow;
    if (!f) return;
    setConnectFlow({ idx: f.saved.length, tested: false, saved: f.saved });
  }

  async function connectFinish() {
    const f = connectFlow;
    const s = store.current;
    if (!f || f.saved.length === 0) return;
    s.connectDone = true;
    setConnectFlow(null);
    const multi = new Set(f.saved.map((x) => x.backend)).size > 1;
    const newConns = f.saved.map((x) => x.connection).filter((c) => !connectBase.current.includes(c));

    // 追加模式：为已加入画布的新表算新候选对，增量裁决后重新发布
    if (connectBase.current.length > 0 && newConns.length > 0) {
      say(`${newConns.join("、")} 已连接。`);
      const oldPairs = s.evidence ?? [];
      const all = await (await fetch("/api/overlap")).json();
      const backends = new Set((s.schemas ?? []).map((x: any) => x.backend ?? x.connection));
      const fresh = all.filter(
        (e: any) =>
          pairBackendsOf(e.pair).every((b) => backends.has(b)) &&
          pairStaged(s, e.pair) &&
          !oldPairs.some((o: any) => o.pair === e.pair),
      );
      s.evidence = [...oldPairs, ...fresh];
      const hasNewObjects = (s.drafts ?? []).some((d: any) => newConns.includes(d.connection));
      if (fresh.length > 0) {
        say(`新表和现有对象产生了 ${fresh.length} 对新候选对——只需要裁决这些新对（已裁的保持原样）：`);
        setWizardStep("integrate");
        setDecisionOpen(true);
      } else if (s.merged && hasNewObjects) {
        say("新表没有产生新的候选对，直接重新发布，把新对象纳入本体。");
        await tPublish();
        say(`已发布 v${s.version}。`);
      } else if (hasNewObjects) {
        say("草稿集已更新。", { suggestions: suggestions() });
      }
      setPickerOpen(false);
      rerender();
      return;
    }

    say(
      multi
        ? `${f.saved.length} 个数据源已就绪（只读）。注意 candidate.mobile 是 +86 带连字符的脏格式——后面算交集前要先归一化。`
        : "数据源已就绪（只读）。单个源没有跨源合并问题——流程会跳过「多源整合」这一步。",
    );
    // 表由人挑：从源里选表加入画布，AI 按表产草稿——人的关卡在确认与裁决
    setWizardStep("model");
    setPickerOpen(!(s.drafts?.length)); // 一张表都没加就留着选表器
    rerender();
  }

  // ---------- 选表上画布（staging）：用户挑表，AI 按表产草稿 ----------
  async function stageTable(conn: string, table: string) {
    const s = store.current;
    if (!s._draftAll) s._draftAll = await (await fetch("/api/draft")).json();
    const backend = (s.schemas ?? []).find((x: any) => x.connection === conn)?.backend ?? conn;
    const base = s._draftAll.find((d: any) => d.connection === conn) ?? s._draftAll.find((d: any) => d.connection === backend) ?? s._draftAll[0];
    const obj = Object.values<any>(base.ontology.object_types).find((o: any) => o.sources.some((src: any) => src.table === table));
    if (!obj) return;
    s.drafts = s.drafts ?? [];
    let d = s.drafts.find((x: any) => x.connection === conn);
    if (!d) {
      d = { connection: conn, ontology: { object_types: {}, link_types: [] }, yaml: "" };
      s.drafts.push(d);
    }
    if (!d.ontology.object_types[obj.name]) {
      const clone = structuredClone(obj);
      for (const src of clone.sources) src.connection = conn;
      d.ontology.object_types[obj.name] = clone;
      d.ontology.link_types = (base.ontology.link_types ?? []).filter((l: any) => d.ontology.object_types[l.from] && d.ontology.object_types[l.to]);
      d.yaml = toYaml(d.ontology);
      setWizardStep("model");
      rerender();
    }
  }

  function unstageTable(conn: string, table: string) {
    const s = store.current;
    const d = s.drafts?.find((x: any) => x.connection === conn);
    if (!d) return;
    for (const [name, o] of Object.entries<any>(d.ontology.object_types)) {
      if (o.sources.some((src: any) => src.table === table)) delete d.ontology.object_types[name];
    }
    d.ontology.link_types = d.ontology.link_types.filter((l: any) => d.ontology.object_types[l.from] && d.ontology.object_types[l.to]);
    d.yaml = toYaml(d.ontology);
    if (Object.keys(d.ontology.object_types).length === 0) s.drafts = s.drafts.filter((x: any) => x.connection !== conn);
    s.drafts = [...s.drafts];
    rerender();
  }

  async function stageAll() {
    for (const sv of store.current.schemas ?? []) for (const t of sv.tables) await stageTable(sv.connection, t.name);
  }

  // 手动新建对象（无源）：进 manual 草稿桶；已发布则直接进合并本体（版本 +1）。返回对象名。
  function createObject(): string {
    const s = store.current;
    const taken = new Set([
      ...Object.keys(s.merged?.ontology.object_types ?? {}),
      ...(s.drafts ?? []).flatMap((d: any) => Object.keys(d.ontology.object_types)),
    ]);
    let n = taken.size + 1;
    let name = `object_${n}`;
    while (taken.has(name)) name = `object_${++n}`;
    const obj = {
      name,
      label: "新对象",
      properties: [{ name: "id", type: "uuid", pk: true, label: "ID" }],
      sources: [] as any[],
    };
    if (s.merged) {
      s.merged.ontology.object_types[name] = obj;
      s.merged.yaml = toYaml(s.merged.ontology);
      s.version += 1;
      s.history.push({
        version: s.version,
        yaml: s.merged.yaml,
        ontology: structuredClone(s.merged.ontology),
        merge_decisions: s.merged.merge_decisions,
        at: new Date().toISOString(),
        note: "画布新建对象",
      });
    } else {
      s.drafts = s.drafts ?? [];
      let d = s.drafts.find((x: any) => x.connection === "manual");
      if (!d) {
        d = { connection: "manual", ontology: { object_types: {}, link_types: [] }, yaml: "" };
        s.drafts.push(d);
      }
      d.ontology.object_types[name] = obj;
      d.yaml = toYaml(d.ontology);
      setWizardStep("model");
    }
    rerender();
    return name;
  }

  // merged 本体的固定收尾：同步 YAML、版本 +1、入历史
  function touchMerged(note: string) {
    const s = store.current;
    if (!s.merged) return;
    s.merged.yaml = toYaml(s.merged.ontology);
    s.version += 1;
    s.history.push({
      version: s.version,
      yaml: s.merged.yaml,
      ontology: structuredClone(s.merged.ontology),
      merge_decisions: s.merged.merge_decisions,
      at: new Date().toISOString(),
      note,
    });
  }

  // 画布连线建关系：已发布进合并本体（版本 +1）；草稿期同桶进桶、跨桶进 manual 桶
  // （manual 桶的 link 用对象原名，发布时两端都在才带入——buildMergedOntology 同一规则）
  function createLink(from: { conn: string | null; name: string }, to: { conn: string | null; name: string }, linkName: string): string | null {
    const name = linkName.trim();
    if (!name) return "关系名不能为空";
    const s = store.current;
    if (s.merged) {
      const ont = s.merged.ontology;
      if (!ont.object_types[from.name] || !ont.object_types[to.name]) return "对象不存在（可能刚被移除）";
      if (ont.link_types.some((l: any) => l.name === name)) return `关系名重复：${name}`;
      ont.link_types.push({ name, from: from.name, to: to.name, via: { manual: true } });
      touchMerged(`画布连线 ${name}`);
    } else {
      if (from.conn !== to.conn && from.name === to.name) return "两个源里的同名对象，跨源连线请先各自改名";
      const all = (s.drafts ?? []).flatMap((d: any) => d.ontology.link_types);
      if (all.some((l: any) => l.name === name)) return `关系名重复：${name}`;
      const conn = from.conn === to.conn ? from.conn : "manual";
      s.drafts = s.drafts ?? [];
      let d = s.drafts.find((x: any) => x.connection === conn);
      if (!d) {
        d = { connection: "manual", ontology: { object_types: {}, link_types: [] }, yaml: "" };
        s.drafts.push(d);
      }
      d.ontology.link_types.push({ name, from: from.name, to: to.name, via: { manual: true } });
      d.yaml = toYaml(d.ontology);
      s.drafts = [...s.drafts];
    }
    rerender();
    return null;
  }

  // 关系改名：按所在本体定位（merged 或某个草稿桶）
  function renameLink(conn: string | null, orig: string, next: string): string | null {
    const name = next.trim();
    if (!name) return "关系名不能为空";
    const s = store.current;
    if (s.merged) {
      const ls = s.merged.ontology.link_types;
      const l = ls.find((x: any) => x.name === orig);
      if (!l) return "关系不存在（可能刚被移除）";
      if (name !== orig && ls.some((x: any) => x.name === name)) return `关系名重复：${name}`;
      l.name = name;
      touchMerged(`关系改名 ${orig} → ${name}`);
    } else {
      const d = s.drafts?.find((x: any) => x.connection === conn);
      const l = d?.ontology.link_types.find((x: any) => x.name === orig);
      if (!l) return "关系不存在（可能刚被移除）";
      const all = (s.drafts ?? []).flatMap((x: any) => x.ontology.link_types);
      if (name !== orig && all.some((x: any) => x.name === name)) return `关系名重复：${name}`;
      l.name = name;
      d.yaml = toYaml(d.ontology);
      s.drafts = [...s.drafts!];
    }
    rerender();
    return null;
  }

  function deleteLink(conn: string | null, orig: string) {
    const s = store.current;
    if (s.merged) {
      s.merged.ontology.link_types = s.merged.ontology.link_types.filter((x: any) => x.name !== orig);
      touchMerged(`删除关系 ${orig}`);
    } else {
      const d = s.drafts?.find((x: any) => x.connection === conn);
      if (!d) return;
      d.ontology.link_types = d.ontology.link_types.filter((x: any) => x.name !== orig);
      d.yaml = toYaml(d.ontology);
      s.drafts = [...s.drafts!];
    }
    rerender();
  }

  // 画布删除对象：连带清掉挂在它身上的关系。有源对象走「忽略」（来源映射要留着），只有 manual 和已发布的可删
  function deleteObject(kind: "draft" | "merged", conn: string | null, objName: string): string | null {
    const s = store.current;
    if (kind === "merged") {
      if (!s.merged?.ontology.object_types[objName]) return "对象不存在（可能刚被移除）";
      delete s.merged.ontology.object_types[objName];
      s.merged.ontology.link_types = s.merged.ontology.link_types.filter((l: any) => l.from !== objName && l.to !== objName);
      touchMerged(`画布删除「${objName}」`);
    } else {
      if (conn !== "manual") return "有源对象用「忽略」即可——不进本体，但来源映射保留";
      const d = s.drafts?.find((x: any) => x.connection === "manual");
      if (!d?.ontology.object_types[objName]) return "对象不存在（可能刚被移除）";
      delete d.ontology.object_types[objName];
      d.ontology.link_types = d.ontology.link_types.filter((l: any) => d.ontology.object_types[l.from] && d.ontology.object_types[l.to]);
      if (Object.keys(d.ontology.object_types).length === 0 && d.ontology.link_types.length === 0) {
        s.drafts = s.drafts!.filter((x: any) => x.connection !== "manual");
      } else {
        d.yaml = toYaml(d.ontology);
      }
      s.drafts = [...(s.drafts ?? [])];
    }
    rerender();
    return null;
  }

  // 回滚到历史版本的内容——作为新版本发布（Git revert 语义，历史链不断）
  function rollbackTo(v: number) {
    const s = store.current;
    const snap = (s.history ?? []).find((h: any) => h.version === v);
    if (!snap || !s.merged || v === s.version) return;
    s.merged = { ...snap, ontology: structuredClone(snap.ontology) };
    s.version += 1;
    s.history.push({ ...structuredClone(snap), version: s.version, at: new Date().toISOString(), note: `回滚自 v${v}` });
    say(`已回滚到 v${v} 的内容——作为 v${s.version} 重新发布，历史链完整。`);
    rerender();
  }

  // ---------- 裁决：唯一必须人来的环节（审阅面板——LLM 建议一次给全，人逐对定案）----------
  // 面板开关：未发布时按状态自动浮出；已发布后由「全部重裁/重新规划」再打开
  const [decisionOpen, setDecisionOpen] = useState(false);

  // 面板点选：即时写入，静音；业务警示（①丢时间维度等）由面板按当前选择展示
  function setDecision(key: string, type: string) {
    store.current.decisions[key] = type;
    rerender();
  }

  const PAIR_LABEL: Record<string, string> = { person: "人员", department: "部门", position: "职位" };

  // 被忽略的对象对应的表不进裁决队列
  function liveEvidence() {
    const s = store.current;
    if (!s.evidence) return s.evidence;
    if (!s.drafts) return s.evidence;
    const ignoredTables = new Set<string>();
    for (const d of s.drafts) {
      for (const o of Object.values<any>(d.ontology.object_types)) {
        if (o._ignored) for (const src of o.sources) ignoredTables.add(`${src.connection}.${src.table}`);
      }
    }
    return s.evidence.filter((e: any) => ![...ignoredTables].some((t) => e.pair.includes(t)));
  }

  const allDecided = () => {
    const ev = liveEvidence();
    return !!ev && ev.every((e) => store.current.decisions[pairKey(e)]);
  };

  async function afterDecision(key: string, type: string) {
    const comments: Record<string, Record<string, string>> = {
      person: {
        "③": "对——34% 交集 + HR 有在职状态字段，是同一批人先后两个阶段。统一「人员」对象 + status 派生 + converted 转化关系，“转正”才问得出来。",
        "①": "按①处理。但提醒：等价合并会丢掉“转正”的时间维度，“查转正员工”将答不出来。",
        "⑤": "提醒：34% 身份证重合是硬证据，这不是“仅名字像”。按你的裁决处理。",
      },
      department: { "①": "4/4 部门名全重合，等价合并挂双源。" },
      position: { "⑤": "同意，一个是招聘 JD 一个是编制数，各自独立。" },
    };
    say(comments[key]?.[type] ?? `已按 ${type} ${REL_NAME[type]} 处理。`);
    if (allDecided()) {
      if (store.current.merged) {
        await tPublish();
        say(`已按新裁决重新发布 v${store.current.version}。`);
      } else {
        setWizardStep("publish");
        say("三对都裁完了，可以发布合并本体了。");
      }
    }
  }


  // ---------- 意图解释（模拟 LLM 的理解层）----------
  // 对话 chip 只放概念问答与问数示例——流程动作全部在工作台对应面板里
  function suggestions(): string[] {
    const s = store.current;
    if (!s.schemas) return ["交集率是什么意思？", "本体是什么？"];
    if (!s.drafts) return ["五类型是哪五种？", "交集率是什么意思？"];
    if (s.evidence && !allDecided()) return ["为什么建议按生命周期？", "五类型是哪五种？"];
    if (!s.merged) return ["裁决是什么？", "数据边界是什么？"];
    if (!s.artifacts) return ["血缘是什么？", "数据边界是什么？"];
    return ["查所有从候选人转正的员工及其部门", "还有多少候选人？", "血缘是什么？"];
  }

  async function turn(text: string) {
    const t = text.trim();
    if (!t || busy) return;
    push({ role: "user", kind: "text", text: t });
    setBusy(true);
    await sleep(250);
    try {
      await route(t);
    } catch (err) {
      console.error(err);
      say("刚才那步出错了（模拟 Agent 的锅）——换个说法再试试。", { suggestions: suggestions() });
    } finally {
      setBusy(false);
    }
  }

  async function route(t: string) {
    const s = store.current;

    // 0) 重来（精确匹配，避免误吃「重新生成」「重新裁决」等指令）
    if (/^(重新开始|重置|重来|重新来一遍?)$/.test(t)) {
      location.reload();
      return;
    }

    // 0.5) 会话语义：构建类指令在「问数」会话里自动切回构建流程；反之亦然
    const conv = buckets.current[activeWs].activeConv;
    if (/去构建|构建流程/.test(t) && conv === "chat") {
      switchConv("flow");
      return;
    }
    if (/去问数/.test(t) && conv === "flow") {
      switchConv("chat");
      return;
    }
    if (conv === "chat" && /连接|数据源|草稿|建模|逆向|裁决|整合|发布|生成|出码|新系统|确认/.test(t) && !/查|问/.test(t)) {
      switchConv("flow");
      say("（构建相关的操作都在这个会话进行）");
    }

    // 1) 概念解释（任何阶段都可插话）
    const ex = explain(t);
    if (ex) {
      say(ex, { suggestions: suggestions() });
      return;
    }

    // 1.5) 状态/审计 与 重新裁决
    if (/进度|状态|哪一步|审计|台账/.test(t)) {
      statusReport();
      return;
    }
    if (/重新裁决|修改裁决|改一下裁决/.test(t)) {
      if (!s.evidence) {
        say("还没有可裁决的候选对——先连接并生成草稿。", { suggestions: suggestions() });
        return;
      }
      reopenDecisions();
      return;
    }

    // 2) 显式裁决输入："人员按③" / "部门①" / "都按建议"
    //    注意：用户可能跳过"开始裁决"直接说这句——证据还没拉过时先补上
    const decisionIntent = /都按|全按|按建议|听你的/.test(t) || (/[①②③⑤]/.test(t) && Object.values(PAIR_WORDS).some((re) => re.test(t)));
    if (decisionIntent && s.drafts && !s.evidence) await tEvidence();
    if (s.evidence) {
      if (/都按|全按|按建议|听你的/.test(t) && !allDecided()) {
        for (const e of s.evidence) s.decisions[pairKey(e)] = e.suggestion;
        if (s.merged) {
          await tPublish();
          say(`好，全部按系统建议裁决。已按新裁决重新发布 v${s.version}。`);
        } else {
          setWizardStep("publish");
          say("好，三对都按系统建议裁决：人员③、部门①、职位⑤。裁决留痕，可回滚。");
        }
        rerender();
        return;
      }
      let hit = false;
      for (const [key, re] of Object.entries(PAIR_WORDS)) {
        const m = t.match(new RegExp(`(?:${re.source})[^①②③⑤]{0,6}([①②③⑤])`));
        if (m && /[①②③⑤]/.test(t)) {
          s.decisions[key] = m[1];
          hit = true;
          await afterDecision(key, m[1]);
        }
      }
      if (hit) return;
    }

    // 2.4) 连接流程中的选择：再添加 / 完成（必须在 2.5 之前——流程进行中优先匹配流程内选择）
    if (connectFlow) {
      if (/完成|继续/.test(t) && connectFlow.awaiting) {
        await connectFinish();
        return;
      }
      if (/再添加|再加一个|添加一个|再来一个/.test(t)) {
        connectAddMore();
        return;
      }
    }

    // 2.5) 任意时刻添加数据源 / 重新规划对象（非线性本体操作）
    if (/添加.*数据源|再连|再加一个|再添加|新增.*数据源/.test(t)) {
      sayConnectIntro();
      startConnectFlow();
      return;
    }
    if (/重新规划|重新裁决|重新建模|重裁/.test(t)) {
      const s2 = store.current;
      if (!s2.merged && !s2.evidence) {
        say("还没有可重新规划的对象——先完成建模和整合。", { suggestions: suggestions() });
        return;
      }
      if (/人员|候选人|员工/.test(t)) replanObject("person");
      else if (/部门/.test(t)) replanObject("department");
      else if (/职位|岗位|JD|编制/i.test(t)) replanObject("job_posting");
      else reopenDecisions();
      return;
    }

    // 3) 连接数据源（表单交互：配置 → 测试 → 保存内省）
    if (/连接|连一?下|连上|接两个|数据源/.test(t) && !s.connectDone) {
      sayConnectIntro();
      startConnectFlow();
      return;
    }

    // 4) 看表结构
    if (/表结构|看看表|有哪些表|schema/i.test(t)) {
      if (await tConnect()) await sleep(200);
      setWizardStep("connect");
      say("结构和采样都在右边。注意到什么再问。", { suggestions: suggestions() });
      return;
    }

    // 4.5) 确认草稿
    if (/确认草稿|确认本体|确认/.test(t) && s.drafts && !s.draftsConfirmed) {
      confirmDrafts();
      return;
    }

    // 5) 草稿/建模（未连接先走配置表单，连完自动建模）
    if (/草稿|建模|逆向|生成本体/.test(t) && !s.drafts) {
      if (!s.schemas) {
        sayConnectIntro();
        startConnectFlow();
        return;
      }
      await tDraft();
      return;
    }

    // 6) 裁决/整合（未连接先走配置表单，连完自动建模）
    if (/裁决|整合|合并|开始裁/.test(t) && !allDecided()) {
      if (!s.schemas) {
        sayConnectIntro();
        startConnectFlow();
        return;
      }
      await tDraft();
      await tEvidence();
      say("候选对与交集证据已备好——在裁决面板里逐对定案，权在你。");
      setWizardStep("integrate");
      setDecisionOpen(true);
      return;
    }

    // 7) 发布（多源需先裁完；单源/无候选对可直接发布）
    if (/发布/.test(t)) {
      if (s.evidence && s.evidence.length > 0 && !allDecided()) {
        say("还差裁决没做完——这是不能替你做的。在裁决面板里逐对定案：");
        setWizardStep("integrate");
        setDecisionOpen(true);
        return;
      }
      await tPublish();
      return;
    }

    // 8) 生成
    if (/生成|出码|新系统/.test(t)) {
      if (!(await ensurePublished())) return;
      const had = !!s.artifacts;
      await tGenerate();
      say(had ? "已按当前本体重新生成。" : "现在可以直接问我业务问题了。", { suggestions: suggestions() });
      return;
    }

    // 9) 问数（默认兜底：含查询意味，或本体已发布后的任意输入）
    const looksLikeQuery = /查|多少|几个|哪些|有没有|列出|员工|候选人|部门/.test(t);
    if (looksLikeQuery || s.merged) {
      if (!s.merged && conv === "chat") {
        say("本体还没发布——得先在构建流程里把本体做出来。", { suggestions: ["去构建流程"] });
        return;
      }
      if (!(await ensurePublished())) return;
      await tQuery(t);
      return;
    }

    // 10) 兜底
    say("我是规则模拟，能理解的表达有限（正式版换真 LLM 就没这限制）。你可以让我：连接源库 / 生成草稿 / 裁决合并 / 发布本体 / 生成新系统 / 查数据，也可以随时插话问概念。", { suggestions: suggestions() });
  }

  // 前置补齐：任何路径需要本体时，自动跑完能自动的，停在必须人的裁决
  async function ensurePublished(): Promise<boolean> {
    const s = store.current;
    if (s.merged) return true;
    if (await tConnect()) await sleep(200);
    if (await tDraft()) await sleep(200);
    await tEvidence();
    if (!allDecided()) {
      say("要查数据得先有合并本体。连接和草稿我已经跑完，剩下唯一必须你来的——3 对裁决：");
      setWizardStep("integrate");
      setDecisionOpen(true);
      return false;
    }
    await tPublish();
    return true;
  }

  // ---------- 工作台直接动作：只执行，对话静默（quiet），不伪造用户消息 ----------
  // 与 route() 的区别：route 服务真实打字输入（用户气泡是真的、Agent 应答是对话）；
  // 这里服务按钮点击——界面状态变化本身就是反馈，对话无需吱声。
  async function ui(fn: () => Promise<void> | void) {
    if (uiBusy.current) return;
    uiBusy.current = true;
    quiet.current = true;
    try {
      await fn();
    } catch (err) {
      console.error(err);
    } finally {
      quiet.current = false;
      uiBusy.current = false;
      rerender(); // 静音模式下没有消息渲染带动，统一兜底刷新（store 变更落盘到界面）
    }
  }
  const actConnect = () => ui(() => startConnectFlow());
  const actDraft = () =>
    ui(async () => {
      if (!store.current.schemas) return startConnectFlow();
      setPickerOpen(true); // 逆向建模 = 挑表上画布，AI 按表产草稿
    });
  const actIntegrate = () =>
    ui(async () => {
      const s = store.current;
      if (!s.schemas) return startConnectFlow();
      await tDraft();
      await tEvidence();
      if ((liveEvidence()?.length ?? 0) === 0) {
        setWizardStep("publish"); // 无候选对（单源/无跨源同义对象）——整合步本就跳过，直接去发布
        return;
      }
      setWizardStep("integrate");
      setDecisionOpen(true);
    });
  const actDecideSuggested = () =>
    ui(async () => {
      const s = store.current;
      if (!s.evidence || allDecided()) return;
      for (const e of s.evidence) s.decisions[pairKey(e)] = e.suggestion;
      if (s.merged) {
        await tPublish();
        say(`好，全部按系统建议裁决。已按新裁决重新发布 v${s.version}。`);
      } else {
        setWizardStep("publish");
        say("好，三对都按系统建议裁决：人员③、部门①、职位⑤。裁决留痕，可回滚。");
      }
      rerender();
    });
  const actPublish = () =>
    ui(async () => {
      const s = store.current;
      if (s.evidence && s.evidence.length > 0 && !allDecided()) {
        say("还差裁决没做完——这是不能替你做的。在裁决面板里逐对定案：");
        setWizardStep("integrate");
        setDecisionOpen(true);
        return;
      }
      await tPublish();
    });
  const actGenerate = () =>
    ui(async () => {
      const had = !!store.current.artifacts;
      if (!(await ensurePublished())) return;
      await tGenerate();
      say(had ? "已按当前本体重新生成。" : "现在可以直接问我业务问题了。", { suggestions: suggestions() });
    });

  // ---------- 概念解释器 ----------
  function explain(t: string): string | null {
    const s = store.current;
    if (!/什么意思|是什么|为什么|啥|讲讲|解释|五类型|关系类型/.test(t)) return null;
    if (/交集/.test(t))
      return `交集率 = 两个源库标识字段（身份证/手机号）归一化后的集合重合度。它回答"两个系统里的记录是不是同一批现实实体"——schema 命名会骗人，数据不会。${s.evidence ? `比如当前人员这对：17/50 = 34%，居中，指向生命周期。` : "连上库后我可以算给你看。"}`;
    if (/归一化/.test(t))
      return "算交集前先把标识字段洗成统一格式（去 +86、连字符、空格，跳过脱敏字段），否则同一批人会算成零重合。规则库自动匹配，LLM 只兜底建议，执行全走确定性 SQL。";
    if (/五类型|关系类型|哪五种/.test(t))
      return "跨源合并的五种关系类型：①完全等价（合并单对象）②部分重叠（上位对象）③生命周期阶段（统一对象+状态+转化）④子类型（Interface，V2）⑤仅名字像（不合并）。合并不是二元判断，判错类型比不合并更糟。";
    if (/生命周期|为什么建议/.test(t))
      return "候选人→员工是同一批人在不同时间的状态：招聘库 50 人、HR 库 40 人，17 人身份证重合——这 17 人就是“已转正”。建模为统一「人员」对象 + status 派生属性（仅招聘源→候选人；命中 HR 源→在职/离职）+ converted 转化关系，之后才能问“查所有转正的人”。";
    if (/本体/.test(t))
      return "本体 = 业务对象/属性/关系的机器可读定义（YAML）。它是单一事实源：生成新系统以它为蓝图，Agent 问数以它为上下文，血缘从它出发。五个概念：对象类型、属性、关系、源映射、接口（V2）。";
    if (/血缘/.test(t))
      return "血缘 = 字段级映射链：新系统任一字段 → 本体属性 → 源表列。问数时的“取数路径”是查询级血缘，复用同一份映射数据。它是审计和信任的基础。";
    if (/迁移|数据边界|落地/.test(t))
      return "数据边界：平台不迁移、不复制业务数据。交集在内存算、标识集合不落地；问数实时查源库；新系统空库起步只承接增量。存量数据迁移是 V2 的事。";
    if (/裁决/.test(t))
      return "裁决 = 对跨源同义对象选择关系类型。流程是：LLM 给建议+理由（软证据）→ 数据交集率（硬证据）→ 你拍板 + 业务测试问题集验证。裁决和证据快照全部留痕，可回滚——这是护城河“裁决知识库”的原始积累。";
    return null;
  }

  // ---------- 流程：从工作空间状态推导，不写死 ----------
  // 六步更细粒度；单源或无候选对 → 没有"多源整合"这一步。
  function computeSteps(s: any) {
    const backends = new Set((s.schemas ?? []).map((x: any) => x.backend ?? x.connection));
    const needAdj = s.evidence ? s.evidence.length > 0 : backends.size > 1;
    const adjudicated = (() => {
      const ev = liveEvidence();
      return !!ev && ev.length > 0 && ev.every((e: any) => s.decisions[pairKey(e)]);
    })();
    const raw = [
      { key: "connect", name: "连接数据源", needs: null as string | null, done: !!s.connectDone },
      { key: "model", name: "逆向建模", needs: "connect", done: !!s.draftsConfirmed },
      // 流程骨架恒定四步：单源无候选对时，建模确认完成即算整合步自动跳过
      { key: "integrate", name: "多源整合", needs: "model", done: needAdj ? adjudicated : !!s.draftsConfirmed },
      { key: "publish", name: "发布本体", needs: "integrate", done: !!s.merged },
      // 生成新系统不是流程步骤——发布即自动出码；问数同理，是通用对话能力
    ];
    return raw.map((st) => ({
      ...st,
      state: st.done
        ? ("done" as const)
        : st.needs && !raw.find((r) => r.key === st.needs)!.done
          ? ("locked" as const)
          : ("open" as const),
    }));
  }
  const steps = computeSteps(store.current);

  // 当前真正可做的那一步（所有提示统一指向它）
  function nextStep() {
    return steps.find((s) => s.state === "open") ?? steps[0];
  }

  // 锁定/查看步骤的拦截反馈：瞬时 toast，不写对话（UI 点击不发消息）
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  function showNotice(text: string) {
    setNotice(text);
    if (noticeTimer.current) clearTimeout(noticeTimer.current);
    noticeTimer.current = setTimeout(() => setNotice(null), 2600);
  }
  function lockedHint(stepName: string) {
    const target = steps.find((s) => s.name === stepName || s.key === stepName);
    const next = nextStep();
    showNotice(`「${target?.name ?? stepName}」还没到时候——流程是顺序执行的，先完成「${next.name}」`);
  }

  // 侧栏步骤 = 进度展示（不重复执行）；点击给状态反馈，动作入口在画布浮动卡上
  function stepClick(key: string) {
    const st = steps.find((s) => s.key === key)!;
    if (st.state === "locked") return lockedHint(key);
    setWs({ type: "welcome" }); // 清掉取数详情视图
    setWizardStep(key);
    showNotice(st.state === "done" ? `「${st.name}」已完成` : `当前阶段：${st.name}——动作在画布上的浮动卡里`);
  }

  // ---------- 侧栏资源 → 工作台对应步骤/模态 ----------
  function openView(kind: "schema" | "ontology" | "code") {
    setWs({ type: "welcome" }); // 清掉取数详情视图
    if (kind === "schema") setWizardStep("connect");
    else if (kind === "ontology") setWizardStep(store.current.drafts ? "model" : "connect");
    else if (kind === "code") setWizardStep("generate");
    rerender();
  }

  const badges = {
    confirmed: !!store.current.draftsConfirmed,
    sources: store.current.schemas?.length ?? 0,
    objects: store.current.merged
      ? Object.keys(store.current.merged.ontology.object_types).length
      : (store.current.drafts?.reduce((n: number, x: any) => n + Object.keys(x.ontology.object_types).length, 0) ?? 0),
    version: store.current.merged ? store.current.version : null,
    generated: !!store.current.artifacts,
  };

  return {
    msgs, ws, busy, badges, turn, decisionOpen, setDecisionOpen, setDecision, notice,
    chats: buckets.current[activeWs].chats, activeChatId, newChat, switchChat,
    applyYaml, updateObject, applyObjectYaml, regenerate, replay, reopenDecisions,
    wsList, activeWs, switchWorkspace, newWorkspace,
    steps, stepClick, lockedHint, openView,
    connectFlow, connectTest, connectSave, connectAddMore, connectFinish,
    confirmDrafts, toggleIgnore, ui, rollbackTo,
    pickerOpen, setPickerOpen, stageTable, unstageTable, stageAll, createObject,
    createLink, renameLink, deleteLink, deleteObject,
    actConnect, actDraft, actIntegrate, actDecideSuggested, actPublish, actGenerate,
    convs: CONVS, activeConv, switchConv,
    replanObject,
    wizardStep, setWizardStep,
    data: store.current,
  };
}
