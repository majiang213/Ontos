// 会话存储 —— 对话页的会话模型：会话列表、当前会话、追加消息、localStorage 持久化（含数据边界裁剪）。
// 移出 React 的原因：这块状态的生命周期是「会话」不是「渲染」——ensureSession 要在异步回调里读当前会话，
// 在组件里只能拿 state/ref 双轨代偿。收进本模块后 curId 只有一份，组件只订阅（useSyncExternalStore）。
// 数据边界承诺在这里落地：空会话不落库；答案卡只留前 20 行做回看（带裁剪前总数），完整数据永远在源库现查。

export interface Msg {
  role: "user" | "agent";
  text?: string;
  answer?: { query: Record<string, unknown>; rows: Record<string, unknown>[]; path: string[]; question?: string; total?: number }; // total：裁剪持久化前的真实总数
  actionResult?: { ok: boolean; error?: string; projections: { source: string; table: string; op: string; ok: boolean; error?: string; note?: string }[] };
}

export interface Session {
  id: string;
  title: string;
  msgs: Msg[];
}

const TRIM_ROWS = 20;

/** 持久化后端的最小形状：浏览器是 localStorage，测试传内存 stub。 */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export class SessionStore {
  private sessions: Session[] = [];
  private curId: string | null = null;
  private inited = false; // 读回完成前不落库（init 只能晚到：浏览器里 localStorage 挂载后才读）
  private listeners = new Set<() => void>();
  /** 动作成功后的复查问题：跨调用的流程状态，不从消息列表反推。
   *  显式不持久化（内存态）：它是「这次坐在这里」的流程上下文，刷新即丢是设计，不是遗漏。 */
  private lastQ: string | null = null;

  /** 记一条「上一条问题」（问数与台账重跑都算）。 */
  noteQuestion(q: string): void {
    this.lastQ = q;
  }

  /** 动作成功后的复查用：取上一条问题（没有则 null）。 */
  takeFollowup(): string | null {
    return this.lastQ;
  }

  constructor(
    private ws: string,
    private storage: StorageLike | null = typeof localStorage !== "undefined" ? localStorage : null // 服务端渲染没有 localStorage：空存储，init/persist 空转
  ) {}

  private key(): string {
    return `ontos-chat-sessions:${this.ws}`;
  }

  /* ---------- 订阅（useSyncExternalStore） ---------- */
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  getSessions = (): Session[] => this.sessions;
  getCurId = (): string | null => this.curId;

  private emit(): void {
    for (const fn of this.listeners) fn();
    this.persist();
  }

  /* ---------- 持久化（数据边界：裁剪后才写） ---------- */
  private persist(): void {
    if (!this.inited || !this.storage) return;
    try {
      const trimmed = this.sessions
        .filter((s) => s.msgs.length > 0) // 空会话不落库（没说过话的会话不是会话）
        .map((s) => ({
          ...s,
          msgs: s.msgs.map((m) => (m.answer ? { ...m, answer: { ...m.answer, total: m.answer.total ?? m.answer.rows.length, rows: m.answer.rows.slice(0, TRIM_ROWS) } } : m)),
        }));
      this.storage.setItem(this.key(), JSON.stringify(trimmed));
    } catch {
      // 配额满了不挡对话
    }
  }

  /** 挂载后读回（只在客户端调；刷新不丢）。坏数据当没有。 */
  init = (): void => {
    if (this.inited) return;
    this.inited = true;
    if (!this.storage) return;
    try {
      const raw = this.storage.getItem(this.key());
      if (raw) {
        const s = (JSON.parse(raw) as unknown[]).filter(
          (x): x is Session => Boolean(x) && typeof (x as Session).id === "string" && Array.isArray((x as Session).msgs)
        );
        this.sessions = s;
        this.curId = s[0]?.id ?? null;
      }
    } catch {
      // 坏数据当没有
    }
    for (const fn of this.listeners) fn();
  };

  /* ---------- 会话模型 ---------- */
  /** 新建会话 = 开一页待写的空白（不落列表）；发出第一条消息时 ensureSession 自动落成会话。 */
  newSession(): void {
    this.curId = null;
    this.emit();
  }

  /** 切到某个已有会话。 */
  select(sid: string): void {
    this.curId = sid;
    this.emit();
  }

  /** 没有会话就先开一个（标题取第一句问的话）。读的是模块内唯一一份 curId，不需要 ref 双轨。 */
  ensureSession(titleSeed: string): string {
    if (this.curId) return this.curId;
    const id = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    this.sessions = [{ id, title: titleSeed.slice(0, 24), msgs: [] }, ...this.sessions];
    this.curId = id;
    this.emit();
    return id;
  }

  append(sid: string, m: Msg): void {
    this.sessions = this.sessions.map((s) => (s.id === sid ? { ...s, msgs: [...s.msgs, m] } : s));
    this.emit();
  }

  /** 一次对话往返：开会话（或复用当前）→ 落用户消息 → 跑请求 → 落 agent 消息。
   *  失败落「出错了」文本并返回 null（调用方据此决定是否续动作）。busy 闸在调用方。 */
  async runFlow(seed: string, userText: string, call: () => Promise<Msg>): Promise<Msg | null> {
    const sid = this.ensureSession(seed);
    this.append(sid, { role: "user", text: userText });
    try {
      const msg = await call();
      this.append(sid, msg);
      return msg;
    } catch (e) {
      this.append(sid, { role: "agent", text: `出错了：${e instanceof Error ? e.message : String(e)}` });
      return null;
    }
  }

  removeSession(sid: string): void {
    const rest = this.sessions.filter((s) => s.id !== sid);
    this.sessions = rest;
    if (this.curId === sid) this.curId = rest[0]?.id ?? null;
    this.emit();
  }
}
