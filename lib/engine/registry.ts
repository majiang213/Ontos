// 驱动注册表 —— 连接名 → 驱动。fixture 连接与 mysql/pg 连接共存，引擎按连接名路由。
// 问数与动作只认连接名；注册表是 SourceDriver 的一种（多方言混合，不带 dialect 属性）。

import type { Condition, SourceDriver, TableInfo } from "./driver";
import { EngineReject } from "./individual";

export class DriverRegistry implements SourceDriver {
  private drivers = new Map<string, SourceDriver>();

  register(connection: string, driver: SourceDriver): void {
    this.drivers.set(connection, driver);
  }

  unregister(connection: string): void {
    const d = this.drivers.get(connection);
    this.drivers.delete(connection);
    void d?.close?.(); // 连接池/文件句柄随注销释放
  }

  has(connection: string): boolean {
    return this.drivers.has(connection);
  }

  connectionNames(): string[] {
    return [...this.drivers.keys()];
  }

  private resolve(connection: string): SourceDriver {
    const d = this.drivers.get(connection);
    if (!d) throw new EngineReject(`未注册的连接：${connection}`);
    return d;
  }

  async select(connection: string, table: string, columns: string[], conditions: Condition[]) {
    return this.resolve(connection).select(connection, table, columns, conditions);
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
    if (!d.introspect) throw new Error(`连接 ${connection} 不支持内省`);
    return d.introspect(connection);
  }
  async sample(connection: string, table: string, limit = 3): Promise<Record<string, unknown>[]> {
    const d = this.resolve(connection);
    if (!d.sample) throw new Error(`连接 ${connection} 不支持采样`);
    return d.sample(connection, table, limit);
  }
}
