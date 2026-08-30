// 画布几何测试：borderPoint 四象限与退化、pinPoint 四边插值、closestBorderPin 最近边/夹取/角点并列、rectOf 回退。
// 纯函数零夹具，interface 就是测试面（components/canvas/geometry.ts）。

import { describe, expect, it } from "vitest";
import { borderPoint, closestBorderPin, labelPushOf, pinPoint, rectOf } from "../components/canvas/geometry";
import { NODE_H, NODE_W } from "../components/canvas/layout";

const R = { x: 100, y: 50, w: 200, h: 100 }; // 中心 (200, 100)

describe("borderPoint（中心连线与边框的交点）", () => {
  it("四象限：交点落在射线先碰到的那条边上", () => {
    expect(borderPoint(R, { x: 500, y: 100 })).toEqual({ x: 300, y: 100 }); // 正右 → 右边
    expect(borderPoint(R, { x: -50, y: 100 })).toEqual({ x: 100, y: 100 }); // 正左 → 左边
    expect(borderPoint(R, { x: 200, y: -50 })).toEqual({ x: 200, y: 50 }); // 正上 → 上边
    expect(borderPoint(R, { x: 200, y: 400 })).toEqual({ x: 200, y: 150 }); // 正下 → 下边
    // 斜向：|dx|=400、|dy|=50，w/2/|dx| = 100/400 先收紧 → 右边，y 按坡度走
    expect(borderPoint(R, { x: 600, y: 150 })).toEqual({ x: 300, y: 112.5 });
  });
  it("退化：目标即中心时返回中心（不除零）", () => {
    expect(borderPoint(R, { x: 200, y: 100 })).toEqual({ x: 200, y: 100 });
  });
});

describe("pinPoint（钉点 → 边框实际点）", () => {
  it("四边按 t 插值", () => {
    expect(pinPoint(R, { side: "top", t: 0.5 })).toEqual({ x: 200, y: 50 });
    expect(pinPoint(R, { side: "bottom", t: 0 })).toEqual({ x: 100, y: 150 });
    expect(pinPoint(R, { side: "left", t: 1 })).toEqual({ x: 100, y: 150 });
    expect(pinPoint(R, { side: "right", t: 0.25 })).toEqual({ x: 300, y: 75 });
  });
});

describe("closestBorderPin（最近边框候选）", () => {
  it("矩形外的点：夹到最近边，pin 与实际点同给", () => {
    const hit = closestBorderPin(R, { x: 250, y: -100 }); // 正上方远处
    expect(hit.pin).toEqual({ side: "top", t: 0.75 });
    expect(hit.point).toEqual({ x: 250, y: 50 });
  });
  it("右侧偏上：右边比上边近", () => {
    const hit = closestBorderPin(R, { x: 400, y: 110 });
    expect(hit.pin.side).toBe("right");
    expect(hit.point).toEqual({ x: 300, y: 110 });
  });
  it("角点并列：按 top/bottom/left/right 声明序取先（浮动端点法线反推的同序约定）", () => {
    const hit = closestBorderPin(R, { x: 100, y: 50 }); // 左上角
    expect(hit.pin.side).toBe("top");
    expect(hit.pin.t).toBe(0);
  });
  it("浮动端点法线反推：borderPoint 的点已在边框上，最近候选的 side 即射线命中的边", () => {
    const p = borderPoint(R, { x: 600, y: 150 }); // 右边
    expect(closestBorderPin(R, p).pin.side).toBe("right");
    const q = borderPoint(R, { x: 200, y: -50 }); // 上边
    expect(closestBorderPin(R, q).pin.side).toBe("top");
  });
});

describe("rectOf（React Flow 节点 → 矩形）", () => {
  it("已测量用实测；未测量回退 layout 常量", () => {
    const node = (width?: number, height?: number) => ({ internals: { positionAbsolute: { x: 1, y: 2 } }, measured: { width, height } });
    expect(rectOf(node(220, 90))).toEqual({ x: 1, y: 2, w: 220, h: 90 });
    expect(rectOf(node())).toEqual({ x: 1, y: 2, w: NODE_W, h: NODE_H });
  });
});

describe("labelPushOf（线标签让位：压到节点就推档，法线推不动就切向让位）", () => {
  const label = { w: 80, h: 20 };
  it("无障碍：返回 base 原值、不切向让位", () => {
    expect(labelPushOf({ x: 0, y: 0 }, { x: 1, y: 0 }, label, [], 30)).toEqual({ push: 30, shift: 0 });
  });
  it("标签落点压到节点：沿法线推到第一档不撞为止", () => {
    // 法向 (0,1)：标签从 (0,0) 沿 +y 推；节点横在 y=25 处（base 30 时标签 y 20..40 撞它）
    const obstacle = { x: -100, y: 25, w: 200, h: 5 };
    expect(labelPushOf({ x: 0, y: 0 }, { x: 1, y: 0 }, label, [obstacle], 30)).toEqual({ push: 54, shift: 0 });
  });
  it("竖着放（法向在 x）：同理沿 x 让开", () => {
    // 法向 (-1,0)：标签中心沿 -x 推；障碍横在 x -25..-20（base 30 时标签 x -70..-10 压它）
    const obstacle = { x: -25, y: -100, w: 5, h: 200 };
    expect(labelPushOf({ x: 0, y: 0 }, { x: 0, y: 1 }, label, [obstacle], 30)).toEqual({ push: 78, shift: 0 }); // p=54 时标签 x -94..-14 仍压着它，p=78 才净
  });
  it("法线推不动（标签侧边被高瘦障碍挡住）：切向让位一档即净", () => {
    // 法向 (0,1)：标签 x 范围只随切向 shift 变；高瘦障碍贴在标签右缘（x 25..40，纵贯全部推档的 y 带）
    const obstacle = { x: 25, y: -100, w: 15, h: 200 };
    expect(labelPushOf({ x: 0, y: 0 }, { x: 1, y: 0 }, label, [obstacle], 30)).toEqual({ push: 30, shift: -40 }); // 法线推多少 x 都不动，切向 -40 净
  });
});
