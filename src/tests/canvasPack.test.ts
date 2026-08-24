// 画布包读回降级直测：坏键当没有，不拖死整包；config 键不在这层校验（调用方过 configSchema 硬炸）。

import { describe, expect, it } from "vitest";
import { applyPack, canvasSnapshot, unpackCanvas, type DraftState } from "../server/engine/draft/canvasPack";

describe("unpackCanvas（画布包读回降级）", () => {
  it("全形包：config 与界面状态三键原样返回", () => {
    const raw = {
      config: { object_types: {} },
      layout: { a: { x: 1, y: 2 } },
      edgeBends: { l: { dx: 3, dy: 4 } },
      edgePins: { l: { source: { side: "top", t: 0.5 } } },
    };
    const pack = unpackCanvas(raw);
    expect(pack.config).toEqual({ object_types: {} });
    expect(pack.layout).toEqual({ a: { x: 1, y: 2 } });
    expect(pack.edgeBends).toEqual({ l: { dx: 3, dy: 4 } });
    expect(pack.edgePins).toEqual({ l: { source: { side: "top", t: 0.5 } } });
  });

  it("界面状态键带坏项：该键整体降级为没有（不拖死整包）；钉点只坏一端则只丢那一端", () => {
    const badLayout = unpackCanvas({ config: {}, layout: { a: { x: 1, y: 2 }, b: { x: "bad" } } });
    expect(badLayout.layout).toBeUndefined(); // 注：layout/bends 是整条记录降级，不是逐键降级
    expect(badLayout.config).toEqual({});
    const badPin = unpackCanvas({ config: {}, edgePins: { l: { source: { side: "weird", t: 9 }, target: { side: "top", t: 0.5 } } } });
    expect(badPin.edgePins).toEqual({ l: { target: { side: "top", t: 0.5 } } }); // 单端 catch：只丢坏的那一端
  });

  it("旧格式（顶上就是 object_types）按只有 config 处理；摆位-only 行 config 为 undefined", () => {
    expect(unpackCanvas({ object_types: { a: {} } }).config).toEqual({ object_types: { a: {} } }); // 旧格式：raw 整体即 config
    const only = unpackCanvas({ layout: { a: { x: 1, y: 2 } } });
    expect(only.config).toBeUndefined();
    expect(only.layout).toEqual({ a: { x: 1, y: 2 } });
  });
});

describe("applyPack / canvasSnapshot", () => {
  it("缺键用 fallback，有键覆盖 fallback；snapshot 给缺省键补空", () => {
    const state = { draft: {}, baseVersion: 1, dirty: false, layout: {}, edgeBends: {}, edgePins: {} } as unknown as DraftState;
    applyPack(state, { layout: { a: { x: 1, y: 2 } } }, { layout: { b: { x: 9, y: 9 } }, edgeBends: { l: { dx: 1, dy: 1 } }, edgePins: {} });
    expect(state.layout).toEqual({ a: { x: 1, y: 2 } }); // pack 有键，覆盖 fallback
    expect(state.edgeBends).toEqual({ l: { dx: 1, dy: 1 } }); // pack 缺键，用 fallback
    const snap = canvasSnapshot({ draft: { c: 1 }, baseVersion: 1, dirty: false, layout: {} } as never);
    expect(snap.edgeBends).toEqual({});
    expect(snap.edgePins).toEqual({});
  });
});
