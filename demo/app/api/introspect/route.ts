// M1 连接器：内省 schema + 采样（只读）。demo 返回内存假库。
// 数据边界：身份证/手机号等标识字段脱敏后才出后端——采样仅用于语义判断，标识值不落地。
import { NextResponse } from "next/server";
import { SOURCES, type Column } from "@/lib/sources";

const IDENTITY = /身份证|idcard|id_card/i;
const CONTACT = /手机|电话|邮箱|mobile|phone|email/i;

function maskValue(col: Column, v: unknown): unknown {
  if (v == null) return v;
  const s = String(v);
  const key = `${col.name}${col.comment ?? ""}`;
  if (IDENTITY.test(key)) return s.slice(0, 4) + "**********" + s.slice(-4); // 1101**********000X
  if (CONTACT.test(key)) {
    return s.replace(/(\d{3}-?)\d{4}(-?\d{4})/, "$1****$2"); // +86 138-****-0000 / 138****0000
  }
  return v;
}

export async function GET() {
  const result = SOURCES.map((db) => ({
    connection: db.connection,
    kind: db.kind,
    tables: db.tables.map((t) => ({
      name: t.name,
      comment: t.comment,
      columns: t.columns,
      // 采样 3 行，标识/联系方式列脱敏
      sample: t.rows.slice(0, 3).map((r) =>
        Object.fromEntries(
          Object.entries(r).map(([k, v]) => {
            const col = t.columns.find((c) => c.name === k);
            return [k, col ? maskValue(col, v) : v];
          }),
        ),
      ),
      rowCount: t.rows.length,
    })),
  }));
  return NextResponse.json(result);
}
