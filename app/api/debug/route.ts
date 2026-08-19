// 诊断信标（临时）：前端上报一次渲染环境（浏览器、缩放、视口），排查「线上有、本地没有」的显示差异。
import { NextResponse } from "next/server";

export async function POST(req: Request) {
  try {
    const b = await req.json();
    console.log(`[debug-beacon] dpr=${b.dpr} viewport=${b.w}x${b.h} ua=${b.ua}`);
  } catch {
    // 坏包不挡
  }
  return NextResponse.json({ ok: true });
}
