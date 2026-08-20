// 会话存储测试：会话模型 + 数据边界裁剪承诺（空会话不落库、答案只留前 20 行带裁剪前总数）。
// storage 走构造注入的内存 stub，不碰 localStorage——会话逻辑与数据边界承诺在 node 下直接断言。

import { describe, expect, it } from "vitest";
import { SessionStore, type Msg, type StorageLike } from "../components/sessionStore";

function memStorage(): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => {
      map.set(k, v);
    },
  };
}

const KEY = "ontos-chat-sessions:default";
const answerMsg = (rows: number): Msg => ({ role: "agent", answer: { query: {}, rows: Array.from({ length: rows }, (_, i) => ({ n: i })), path: [] } });

function freshStore(storage = memStorage()) {
  const store = new SessionStore("default", storage);
  store.init();
  return { store, storage };
}

describe("会话模型", () => {
  it("ensureSession：空时新开（标题取首句前 24 字），之后复用当前会话", () => {
    const { store } = freshStore();
    const id1 = store.ensureSession("在役设备及其所属部门还有谁没还");
    const id2 = store.ensureSession("第二个问题");
    expect(id2).toBe(id1);
    expect(store.getSessions()[0].title).toBe("在役设备及其所属部门还有谁没还".slice(0, 24));
    expect(store.getCurId()).toBe(id1);
  });

  it("newSession 只开空白不落列表；发第一条消息才落成会话", () => {
    const { store, storage } = freshStore();
    store.ensureSession("第一个问题");
    store.newSession();
    expect(store.getCurId()).toBeNull();
    expect(JSON.parse(storage.map.get(KEY) ?? "[]")).toEqual([]); // 落库内容里没有空白会话
    const sid = store.ensureSession("真正的第一句");
    store.append(sid, { role: "user", text: "真正的第一句" });
    expect(store.getSessions()).toHaveLength(2);
  });

  it("removeSession：删当前切到下一个；删光回空白；select 切换", () => {
    const { store } = freshStore();
    const a = store.ensureSession("甲");
    store.append(a, { role: "user", text: "甲" });
    store.newSession();
    const b = store.ensureSession("乙");
    store.append(b, { role: "user", text: "乙" });
    store.select(a);
    expect(store.getCurId()).toBe(a);
    store.removeSession(a); // 删当前
    expect(store.getCurId()).toBe(b);
    store.removeSession(b); // 删光
    expect(store.getCurId()).toBeNull();
    expect(store.getSessions()).toHaveLength(0);
  });

  it("订阅：状态变更后监听器收到", () => {
    const { store } = freshStore();
    let calls = 0;
    const off = store.subscribe(() => calls++);
    const sid = store.ensureSession("听");
    store.append(sid, { role: "user", text: "听" });
    store.select(sid);
    off();
    store.newSession();
    expect(calls).toBe(3);
  });

  it("runFlow：成功时按序落用户消息与 agent 消息并返回该消息；失败落「出错了」返回 null", async () => {
    const { store } = freshStore();
    const ok = await store.runFlow("种子问题", "种子问题", async () => ({ role: "agent", text: "答：42" }));
    const msgs = store.getSessions()[0].msgs;
    expect(ok?.text).toBe("答：42");
    expect(msgs.map((m) => `${m.role}:${m.text}`)).toEqual(["user:种子问题", "agent:答：42"]);
    const bad = await store.runFlow("另一个", "另一个", async () => {
      throw new Error("库炸了");
    });
    expect(bad).toBeNull();
    const msgs2 = store.getSessions()[0].msgs;
    expect(msgs2[msgs2.length - 1].text).toBe("出错了：库炸了");
  });
});

describe("数据边界裁剪", () => {
  it("答案卡只留前 20 行，total 记裁剪前总数；文本消息原样保留", () => {
    const { store, storage } = freshStore();
    const sid = store.ensureSession("大结果集");
    store.append(sid, { role: "user", text: "问" });
    store.append(sid, answerMsg(97));
    const saved = JSON.parse(storage.map.get(KEY)!);
    expect(saved[0].msgs[1].answer.rows).toHaveLength(20);
    expect(saved[0].msgs[1].answer.total).toBe(97);
    expect(saved[0].msgs[0].text).toBe("问");
  });

  it("init 从 storage 读回（刷新不丢）；坏数据当没有", () => {
    const storage = memStorage();
    const a = new SessionStore("default", storage);
    a.init();
    const sid = a.ensureSession("留下来的");
    a.append(sid, { role: "user", text: "留下来的" });
    const b = new SessionStore("default", storage); // 模拟刷新后新 store
    b.init();
    expect(b.getSessions().map((s) => s.title)).toEqual(["留下来的"]);
    expect(b.getCurId()).toBe(sid);
    storage.map.set(KEY, "not json{{{");
    const c = new SessionStore("default", storage);
    c.init();
    expect(c.getSessions()).toEqual([]);
  });

  it("工作空间分键：两个空间的会话互不串", () => {
    const storage = memStorage();
    const a = new SessionStore("default", storage);
    a.init();
    a.append(a.ensureSession("默认空间的"), { role: "user", text: "问" });
    const b = new SessionStore("sandbox", storage);
    b.init();
    expect(b.getSessions()).toEqual([]);
  });
});
