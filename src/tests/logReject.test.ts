// 收尾日志守门：业务拒绝（422/400）必须在 toResult 收尾处落服务端日志（message + 堆栈），
// 否则排查「配置不合法」只有前端文案、后端黑盒（见 edit_draft 422 排查需求）。
import { describe, expect, it, vi } from "vitest";
import { DraftReject, MSG, toResult } from "../server/errors";

describe("业务拒绝落日志", () => {
  it("toResult 收成 422 Result 的同时 console.error 打了 message 与堆栈", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const reject = new DraftReject(MSG.cfgIdentityMissing("person", "id_no"));
      const r = await toResult(async () => {
        throw reject;
      }, (v) => v);
      expect(r).toEqual({ code: 422, message: MSG.cfgIdentityMissing("person", "id_no") }); // 形状不变
      expect(spy).toHaveBeenCalledTimes(1);
      const [line] = spy.mock.calls[0];
      expect(String(line)).toContain("业务拒绝");
      expect(String(line)).toContain("配置不合法");
      expect(String(line)).toContain("at "); // 堆栈在打
    } finally {
      spy.mockRestore();
    }
  });

  it("意外异常不进 Result 也不落拒绝日志（原样上抛 = 500）", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await expect(
        toResult(async () => {
          throw new Error("bug");
        }, (v) => v)
      ).rejects.toThrow("bug");
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("respond 兜底 500 也落日志（internalError 同一闸）", async () => {
    const { respond } = await import("../app/api/_shared");
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await respond(async () => {
        throw new Error("boom");
      });
      expect(res.status).toBe(500);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(String(spy.mock.calls[0][0])).toContain("业务拒绝");
      expect(String(spy.mock.calls[0][0])).toContain("boom");
    } finally {
      spy.mockRestore();
    }
  });
});
