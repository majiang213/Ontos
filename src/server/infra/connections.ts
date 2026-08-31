// 连接注册与生命周期 —— 「连接从哪来、怎么活、怎么死」：驱动注册表（全部路由的唯一驱动入口）+
// 保存（测过才落库、失败还回旧驱动）与删除（已发布引用不可删）。
// 单例挂运行态：Next dev 下各路由包各有模块实例，挂全局才能保证即时生效。
// 本文件在 infra 层，不上指 draft：「连接是否被已发布引用」由调用方注入（refs.connectionInUse 是纯函数）。

import { existsSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { ConnectionRec } from "../meta/types";
import { metaStore } from "../meta/store";
import { runtime } from "../runtime";
import { SqliteFixtureDriver } from "./fixture";
import { SqliteDriver } from "./sqliteDriver";
import { readSidecarComments, DEMO_SYSTEMS, DEMO_DIR_REL } from "./demoSystems";
import { DriverRegistry } from "./registry";
import { makeSqlDriver } from "./sqlDriver";
import { ConnectionReject, MSG, toResult, type Result } from "../errors";
import { DEFAULT_WORKSPACE, TEST_WORKSPACE } from "./workspace";
import type { TableInfo } from "./driver";
import { NAME_RE } from "../schema/ops";

// 注册表按工作空间键控，挂运行态（runtime.ts）：Next dev 多模块实例共享，测试换运行态即隔离
function registries(): Map<string, DriverRegistry> {
  return (runtime().registries ??= new Map());
}

/** 驱动注册表（全部路由的唯一驱动入口）：该空间元数据库里保存的连接；演示 fixture 七个内置连接只注入 test——其余空间（含 default）空白起步，数据源自己接。按工作空间键控，与 LLM Key 无关。 */
export async function getDriverRegistry(workspace: string = DEFAULT_WORKSPACE): Promise<DriverRegistry> {
  let r = registries().get(workspace);
  if (!r) {
    const registry = new DriverRegistry();
    if (workspace === TEST_WORKSPACE) {
      const fixture = SqliteFixtureDriver.seeded();
      for (const conn of fixture.connections()) registry.register(conn, fixture);
    }
    for (const rec of await metaStore().listConnections(workspace)) registerSaved(registry, rec);
    r = registry;
    registries().set(workspace, r);
  }
  return r;
}

/** 把元数据库里的连接注册成驱动。新保存的连接在运行时也走这里（即时生效）。
 *  sqlite 文件必须已存在且不是目录——文件没了（被删/被移走）就跳过这个连接，不拖垮整个注册表。 */
export function registerSaved(registry: DriverRegistry, rec: ConnectionRec): void {
  if (rec.type === "sqlite") {
    // SQLite 文件库：db_name 是文件路径
    const p = rec.db_name;
    if (!p || !existsSync(p) || !statSync(p).isFile()) {
      console.warn(`[ontos] 连接 ${rec.name} 的 sqlite 文件不存在，跳过注册：${p}`);
      return;
    }
    // 用户接入的 sqlite 文件库：裸 SqliteDriver——演示种子数据在 fixture 子类，不背进生产路径；
    // 列注释不是演示专属：registerFile 会按 sidecar / 文件名回退载入（sqliteDriver.ts）
    const d = new SqliteDriver();
    d.registerFile(rec.name, p);
    registry.register(rec.name, d);
  } else {
    registry.register(rec.name, makeSqlDriver({ type: rec.type, host: rec.host, port: rec.port, db_name: rec.db_name, ro_user: rec.ro_user, ro_pass: rec.ro_pass, rw_user: rec.rw_user, rw_pass: rec.rw_pass }));
  }
}

/** 数据源抽屉「可接入」的数据源：列出演示库目录里可连接的 .db 文件与建议连接名。
 *  DEMO_SYSTEMS 命中优先（title + 规范连接名）；未命中的按文件名推（小写、非法字符归一为下划线），
 *  推不出合法连接名（NAME_RE）或与前面撞名的文件不列——那个文件还能走表单的手动指定路径。 */
export function listSqliteFiles(dir: string): { file: string; path: string; title?: string; connection: string }[] {
  if (!existsSync(dir)) return [];
  const seen = new Set<string>();
  const out: { file: string; path: string; title?: string; connection: string }[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    if (!ent.isFile() || !ent.name.toLowerCase().endsWith(".db")) continue;
    const sys = DEMO_SYSTEMS.find((s) => s.file === ent.name);
    const name = sys?.connection ?? basename(ent.name).replace(/\.db$/i, "").toLowerCase().replace(/[^a-z0-9_]+/g, "_").replace(/^_+|_+$/g, "");
    if (!NAME_RE.test(name) || seen.has(name)) continue;
    seen.add(name);
    out.push({ file: ent.name, path: join(DEMO_DIR_REL, ent.name), ...(sys ? { title: sys.title } : {}), connection: name });
  }
  return out;
}

/** 保存连接：先注册再测，通过才落库。失败还回旧驱动。test=true 时空库不落库。 */
export async function saveConnection(workspace: string, rec: ConnectionRec, test?: boolean): Promise<Result<{ ok: true; saved: boolean; warning?: string; tables?: TableInfo[] }>> {
  return toResult(async () => {
    const next = { ...rec };
    if (next.type === "sqlite") {
      if (!next.db_name) throw new ConnectionReject(MSG.sqliteNeedsPath, "bad_request");
      // turbopackIgnore：路径来自请求，不能静态分析；cwd 只从运行态读，测试换 tmp 才隔得开
      const p = resolve(/* turbopackIgnore: true */ runtime().cwd, next.db_name);
      if (!existsSync(p)) throw new ConnectionReject(MSG.sqliteFileMissing(p), "bad_request");
      next.db_name = p;
    } else if (!next.host || !next.db_name) {
      throw new ConnectionReject(MSG.sqlNeedsHost, "bad_request");
    }
    const registry = await getDriverRegistry(workspace);
    const previous = (await metaStore().listConnections(workspace)).find((c) => c.name === next.name);
    if (!previous && registry.has(next.name)) {
      throw new ConnectionReject(MSG.demoSourceName(next.name));
    }
    registerSaved(registry, next);
    // 注册后任何一步不过，都把注册表还回旧驱动（previous 在则重挂）——sidecar 严校验与内省测试共用这一个回退
    const rollback = () => {
      registry.unregister(next.name);
      if (previous) registerSaved(registry, previous);
    };
    // sidecar 严校验（表单路径，落库之前）：注释文件存在但读不出 → 拒，不落库。
    // 水合路径（registerFile）对同一情形只警告不加注释——第一次接入坏注释挡在表单，进程重启不会被一份坏 JSON 拖死。
    if (next.type === "sqlite" && next.db_name && readSidecarComments(next.db_name).kind === "corrupt") {
      rollback();
      throw new ConnectionReject(MSG.sidecarCommentsUnreadable(next.db_name), "bad_request");
    }
    let tables: TableInfo[] | undefined;
    if (test) {
      try {
        tables = await registry.introspect(next.name);
        if (tables.length === 0) {
          rollback();
          return { ok: true as const, warning: MSG.connectedNoTables, tables, saved: false };
        }
      } catch (e) {
        rollback();
        // 驱动报错含主机/路径/服务端细节，不原样出网（与 listTables 的净化同一条纪律）；raw 错误吞掉由 catch 兜底
        throw new ConnectionReject(MSG.connectFailed);
      }
    }
    await metaStore().saveConnection(workspace, next);
    return { ok: true as const, saved: true, ...(tables ? { tables } : {}) }; // 表单 toast「读到 N 张表」吃这份
  }, (v) => (v.saved ? MSG.resultConnectionSaved : MSG.connectedNoTables));
}

/** 删除已保存的连接。内置演示源不在元库，删不了；已发布本体还引用着的也不能删——
 *  引用判定由调用方注入（infra 不上指 draft；路由传 refs.connectionInUse ∘ getPublished）。 */
export async function dropConnection(workspace: string, name: string, isReferenced: (name: string) => Promise<boolean>): Promise<Result<void>> {
  return toResult(async () => {
    if (!(await metaStore().listConnections(workspace)).some((c) => c.name === name)) {
      throw new ConnectionReject(MSG.connectionNotFoundBuiltin(name));
    }
    if (await isReferenced(name)) throw new ConnectionReject(MSG.connectionInUsePublished(name));
    await metaStore().deleteConnection(workspace, name);
    (await getDriverRegistry(workspace)).unregister(name);
  }, () => MSG.resultConnectionDropped);
}
