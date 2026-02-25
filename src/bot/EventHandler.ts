import { BotEngine } from "./BotEngine.js";
import { Logger } from "../logger/Logger.js";
import { OrderActionRecord, BN } from "@drift-labs/sdk";

export class EventHandler {
  constructor(private botEngine: BotEngine, private logger: Logger) { }

  public onOrderFill(record: OrderActionRecord): void {
    this.logger.info("收到订单成交事件", {
      ts: record.ts.toString(),
      marketIndex: record.marketIndex,
    });
    this.botEngine.handleOrderFill(record);
  }

  public onOrderCancel(record: OrderActionRecord): void {
    this.logger.info("收到订单取消事件", {
      ts: record.ts.toString(),
      marketIndex: record.marketIndex,
    });
    this.botEngine.handleOrderCancel(record);
  }

  public onPositionChange(): void {
    this.logger.info("收到仓位变化事件");
    this.botEngine.handlePositionChange();
  }

  public onOracleUpdate(price: BN): void {
    // 日志频率太高，仅在 debug 开启
    // this.logger.debug("收到预言机更新事件", { price: price.toString() });
    this.botEngine.handleOracleUpdate(price);
  }
}
