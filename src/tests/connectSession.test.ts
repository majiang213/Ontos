// 连线拖拽会话测试：生命周期 + dropSession 三条纪律（已落成不补 / 命中须别个节点 / last 先更新为松手处）。
// DOM 命中查询经 findNode 参数注入桩，不碰真 DOM（components/canvas/connectSession.ts）。

import { afterEach, describe, expect, it } from "vitest";
import { beginSession, currentSession, dropSession, endSession, fireSession, trackSession, type ConnectSession } from "../components/canvas/connectSession";

const base: Omit<ConnectSession, "fired"> = { kind: "new", fromNode: "a", start: { x: 0, y: 0 }, last: { x: 0, y: 0 }, fromHandleType: null };

afterEach(() => endSession());

describe("connectSession（一次连线拖拽的会话）", () => {
  it("生命周期：begin → track 跟针 → fire 落成 → end 清空", () => {
    expect(currentSession()).toBeNull();
    beginSession(base);
    expect(currentSession()?.fired).toBe(false);
    trackSession({ x: 9, y: 9 });
    expect(currentSession()?.last).toEqual({ x: 9, y: 9 });
    fireSession();
    expect(currentSession()?.fired).toBe(true);
    endSession();
    expect(currentSession()).toBeNull();
    trackSession({ x: 1, y: 1 }); // 无会话自静止，不炸
  });

  it("补命中：命中别个节点 → onDrop 拿 id，last 先更新为松手处（toFlow 换算后）", () => {
    let dropped: string | null = null;
    beginSession({ ...base, onDrop: (h) => (dropped = h) });
    dropSession(50, 60, (p) => ({ x: p.x / 2, y: p.y / 2 }), () => "b");
    expect(dropped).toBe("b");
    expect(currentSession()?.last).toEqual({ x: 25, y: 30 }); // 落点端钉点按松手处算
  });

  it("已落成不补（fired 闸）", () => {
    let dropped: string | null = null;
    beginSession({ ...base, onDrop: (h) => (dropped = h) });
    fireSession();
    dropSession(50, 60, (p) => p, () => "b");
    expect(dropped).toBeNull();
  });

  it("命中 fromNode 不补（自连 veto），last 不动", () => {
    let dropped: string | null = null;
    beginSession({ ...base, onDrop: (h) => (dropped = h) });
    dropSession(50, 60, (p) => p, () => "a");
    expect(dropped).toBeNull();
    expect(currentSession()?.last).toEqual({ x: 0, y: 0 });
  });

  it("没命中节点不补；无会话不炸", () => {
    let dropped: string | null = null;
    beginSession({ ...base, onDrop: (h) => (dropped = h) });
    dropSession(50, 60, (p) => p, () => null);
    expect(dropped).toBeNull();
    endSession();
    expect(() => dropSession(1, 2, (p) => p, () => "b")).not.toThrow();
  });
});
