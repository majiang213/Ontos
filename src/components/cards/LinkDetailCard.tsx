// 关系详情卡（点边弹出）：名称/反向名/描述可改，失焦保存；删关系在底部。
// 关系名是 link_types 的键，不在条目里——改名成功后由 onRenamed 告诉页面让卡跟新名走。
"use client";

import Bezel from "./Bezel";
import AutoTextarea from "./AutoTextarea";

export default function LinkDetailCard({
  name,
  link,
  op,
  showToast,
  onRenamed,
  onClose,
}: {
  name: string;
  link: any;
  op: (body: Record<string, unknown>) => Promise<boolean>;
  showToast: (s: string) => void;
  onRenamed: (newName: string) => void;
  onClose: () => void;
}) {
  return (
    <div className="float-card float-tr" style={{ width: 320 }}>
      <Bezel pad={16}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
          <span style={{ fontFamily: "var(--font-serif)", fontSize: 16 }}>{name}</span>
          <button className="chip" aria-label="关闭" onClick={onClose}>✕</button>
        </div>
        <div style={{ fontSize: 12, lineHeight: 2, color: "var(--ink-3)", margin: "2px 0 10px" }}>
          <div>{link.from} → {link.to}{link.card ? `，基数 ${link.card}` : ""}</div>
          {link.transition && <div>状态转化：{link.transition.property} 从「{link.transition.from}」到「{link.transition.to}」</div>}
          {link.match && <div>配对字段：{link.match.map((m: any) => `${m.from} → ${m.to}`).join("，")}</div>}
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, fontSize: 11, color: "var(--ink-3)" }}>
          <label>
            名称
            <input
              key={`name:${name}`} /* 换关系强制重挂，旧名不写进新关系 */
              className="text-in"
              style={{ width: "100%", fontSize: 12, padding: "6px 10px" }}
              defaultValue={name} /* 关系名是 link_types 的键，不在条目里 */
              onBlur={async (e) => {
                const v = e.target.value.trim();
                if (!v || v === e.target.defaultValue) return;
                const ok = await op({ op: "update_link", name, new_name: v });
                if (ok) {
                  onRenamed(v); // 边以关系名为键：卡跟新名走
                  showToast(`关系已改名为 ${v}（进草稿，发布后生效）`);
                }
              }}
            />
          </label>
          <label>
            反向名（可选）
            <input
              key={`inv:${name}`}
              className="text-in"
              style={{ width: "100%", fontSize: 12, padding: "6px 10px" }}
              defaultValue={link.inverse ?? ""}
              onBlur={async (e) => {
                const v = e.target.value.trim();
                if (v === e.target.defaultValue) return;
                const ok = await op({ op: "update_link", name, inverse: v });
                if (ok) showToast(`反向名已更新（进草稿，发布后生效）`);
              }}
            />
          </label>
          <label>
            描述（可选）
            <AutoTextarea
              key={`desc:${name}`}
              className="ctl"
              minRows={2}
              defaultValue={link.description ?? ""}
              onBlur={async (e) => {
                if (e.target.value === e.target.defaultValue) return;
                const ok = await op({ op: "update_link", name, description: e.target.value });
                if (ok) showToast(`描述已更新（进草稿，发布后生效）`);
              }}
            />
          </label>
        </div>
        <button
          className="chip"
          style={{ color: "var(--danger)", marginTop: 10 }}
          onClick={async () => {
            const ok = await op({ op: "delete_link", name });
            if (ok) {
              onClose();
              showToast(`已删除关系 ${name}（进草稿，发布后生效）`);
            }
          }}
        >
          删除关系
        </button>
      </Bezel>
    </div>
  );
}
