// 驱动注册表 —— 连接名 → 驱动。fixture 连接与 mysql/pg 连接共存，引擎按连接名路由。
// 问数与动作只认连接名；注册表是 SourceDriver 的一种（多方言混合，不带 dialect 属性）。

import type { AggMetric, Condition, SourceDriver, TableInfo } from "./driver";
import { EngineReject, MSG } from "../errors";

export class DriverRegistry implements SourceDriver {
  private drivers = new Map<string, SourceDriver>();

  register(connection: string, driver: SourceDriver): void {
    const old = this.drivers.get(connection);
    if (old && old !== driver) void old.close?.().catch(() => {}); // 同名覆盖先放掉旧连接池，不然池子泄漏
    this.drivers.set(connection, driver);
  }

  unregister(connection: string): void {
    const d = this.drivers.get(connection);
    this.drivers.delete(connection);
    void d?.close?.().catch(() => {}); // 连接池/文件句柄随注销释放；close 失败不炸进程
  }

  has(connection: string): boolean {
    return this.drivers.has(connection);
  }

  connectionNames(): string[] {
    return [...this.drivers.keys()];
  }

  dialectOf(connection: string): "sqlite" | "mysql" | "pg" | undefined {
    return this.drivers.get(connection)?.dialect;
  }

  private resolve(connection: string): SourceDriver {
    const d = this.drivers.get(connection);
    if (!d) throw new EngineReject(MSG.connectionUnregistered(connection));
    return d;
  }

  async select(connection: string, table: string, columns: string[], conditions: Condition[], limit?: number) {
    return this.resolve(connection).select(connection, table, columns, conditions, limit);
  }
  async selectAggregate(connection: string, table: string, group: { column: string; as: string }[], metrics: AggMetric[], conditions: Condition[]) {
    return this.resolve(connection).selectAggregate(connection, table, group, metrics, conditions);
  }
  async insert(connection: string, table: string, row: Record<string, unknown>) {
    return this.resolve(connection).insert(connection, table, row);
  }
  async update(connection: string, table: string, set: Record<string, unknown>, conditions: Condition[]) {
    return this.resolve(connection).update(connection, table, set, conditions);
  }
  async delete(connection: string, table: string, conditions: Condition[]) {
    return this.resolve(connection).delete(connection, table, conditions);
  }
  async introspect(connection: string): Promise<TableInfo[]> {
    const d = this.resolve(connection);
    if (!d.introspect) throw new Error(MSG.introspectUnsupported(connection));
    return d.introspect(connection);
  }
  async sample(connection: string, table: string, limit = 3): Promise<Record<string, unknown>[]> {
    const d = this.resolve(connection);
    if (!d.sample) throw new Error(MSG.sampleUnsupported(connection));
    return d.sample(connection, table, limit);
  }
}
