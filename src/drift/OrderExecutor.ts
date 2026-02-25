import {
  DriftClient,
  OrderParams,
  OrderType,
  PostOnlyParams,
  PRICE_PRECISION,
  BASE_PRECISION,
  BN,
  PositionDirection,
  Order,
  UserAccount,
  OrderStatus,
  isVariant,
  MarketType,
} from "@drift-labs/sdk";
import { Logger } from "../logger/Logger.js";

/**
 * OrderExecutor 类
 * 负责执行所有订单相关操作，包括下单、撤单、原子撤单下单等。
 * 实现了重试机制和精度转换。
 */
export class OrderExecutor {
  private driftClient: DriftClient;
  private logger: Logger;

  constructor(driftClient: DriftClient, logger: Logger) {
    this.driftClient = driftClient;
    this.logger = logger;
  }

  /**
   * 原子性取消并下单
   * 使用 cancelAndPlaceOrders 保证操作原子性
   */
  async cancelAndReplace(
    cancelOrderIds: string[],
    newOrders: OrderParams[]
  ): Promise<void> {
    if (cancelOrderIds.length === 0 && newOrders.length === 0) {
      return;
    }

    // 确保所有 maker 订单设置 PostOnly
    const sanitizedOrders = newOrders.map((order) => this.sanitizeOrderParams(order));
    const orderIds = cancelOrderIds.map((id) => parseInt(id));

    await this.withRetry(async () => {
      this.logger.debug("执行原子撤单下单", {
        cancelCount: orderIds.length,
        newOrderCount: sanitizedOrders.length,
      });

      if (orderIds.length > 0) {
        // 获取撤单指令
        const cancelIx = await this.driftClient.getCancelOrdersByIdsIx(orderIds);
        // 使用 placeOrders 并传入撤单指令作为 optionalIxs，实现原子性
        // 注意：Drift SDK 的 cancelAndPlaceOrders 不支持指定 orderId，因此我们手动组合指令
        const tx = await this.driftClient.placeOrders(
          sanitizedOrders,
          undefined, // txParams
          undefined, // subAccountId
          [cancelIx] // optionalIxs
        );

        this.logger.trade("原子撤单下单成功", {
          txSig: tx,
          cancelledIds: cancelOrderIds,
          newOrders: sanitizedOrders.map((o) => ({
            type: o.orderType,
            price: o.price.toString(),
            size: o.baseAssetAmount.toString(),
            side: o.direction,
          })),
        });
      } else {
        // 如果没有需要撤销的订单，直接下单
        const tx = await this.driftClient.placeOrders(sanitizedOrders);
        this.logger.trade("下单成功", { txSig: tx });
      }
    }, "cancelAndReplace");
  }

  /**
   * 单笔下单
   */
  async placeOrder(params: OrderParams): Promise<void> {
    const sanitizedParams = this.sanitizeOrderParams(params);

    await this.withRetry(async () => {
      this.logger.debug("准备下单", { params: this.formatOrderParamsForLog(sanitizedParams) });
      const tx = await this.driftClient.placeOrders([sanitizedParams]);
      this.logger.trade("下单成功", { txSig: tx });
    }, "placeOrder");
  }

  /**
   * 取消指定订单
   */
  async cancelOrder(orderId: string): Promise<void> {
    await this.withRetry(async () => {
      this.logger.debug("准备取消订单", { orderId });
      // cancelOrder 接受 orderId (number)
      const tx = await this.driftClient.cancelOrdersByIds([parseInt(orderId)]);
      this.logger.trade("订单取消成功", { txSig: tx, orderId });
    }, "cancelOrder");
  }

  /**
   * 取消所有挂单
   */
  async cancelAllOrders(marketIndex?: number): Promise<void> {
    await this.withRetry(async () => {
      this.logger.debug("准备取消所有订单", { marketIndex });
      const tx = await this.driftClient.cancelOrders(undefined, marketIndex);
      this.logger.trade("所有订单取消成功", { txSig: tx });
    }, "cancelAllOrders");
  }

  /**
   * 获取当前所有挂单
   */
  getOpenOrders(marketIndex?: number): Order[] {
    const userAccount = this.driftClient.getUserAccount();
    if (!userAccount) {
      return [];
    }
    return userAccount.orders.filter((order) => {
      const isOpen = isVariant(order.status, "open");
      if (!isOpen) return false;
      
      if (marketIndex !== undefined) {
        return order.marketIndex === marketIndex;
      }
      return true;
    });
  }

  /**
   * 确保订单参数符合规范
   * 1. Maker 订单强制 PostOnly
   * 2. 卖单支持 reduceOnly (由调用方设置，这里不做强制覆盖，除非策略要求)
   *    根据 TODO 4.5 "Ensure all maker orders set PostOnlyParams.TRY_POST_ONLY"
   */
  private sanitizeOrderParams(params: OrderParams): OrderParams {
    const newParams = { ...params };

    // 默认设置为 PERP 市场，如果未指定
    if (newParams.marketType === undefined) {
      newParams.marketType = MarketType.PERP;
    }

    // 4.5 实现 post-only 订单: 确保所有 maker 订单设置 PostOnlyParams.TRY_POST_ONLY
    // 通常 Limit 订单是 Maker 订单
    if (newParams.orderType === OrderType.LIMIT) {
      // 如果没有显式设置 postOnly，或者设置为 NONE，则强制设为 TRY_POST_ONLY
      if (!newParams.postOnly || newParams.postOnly === PostOnlyParams.NONE) {
        newParams.postOnly = PostOnlyParams.TRY_POST_ONLY;
      }
    }

    // 4.6 Oracle Offset 订单
    if (newParams.orderType === OrderType.ORACLE) {
      if (!newParams.postOnly || newParams.postOnly === PostOnlyParams.NONE) {
        newParams.postOnly = PostOnlyParams.TRY_POST_ONLY;
      }
    }

    return newParams;
  }

  /**
   * 4.8 实现精度转换工具方法 (静态)
   */
  static priceToBN(price: number): BN {
    return new BN(price * PRICE_PRECISION.toNumber());
  }

  static sizeToBN(size: number): BN {
    return new BN(size * BASE_PRECISION.toNumber());
  }

  static bnToPrice(price: BN): number {
    return price.toNumber() / PRICE_PRECISION.toNumber();
  }

  static bnToSize(size: BN): number {
    return size.toNumber() / BASE_PRECISION.toNumber();
  }

  /**
   * 4.9 实现重试机制
   * 指数退避重试（1s, 2s, 4s，最多 3 次）
   */
  private async withRetry<T>(fn: () => Promise<T>, operationName: string): Promise<T> {
    const maxRetries = 3;
    let attempt = 0;

    while (true) {
      try {
        return await fn();
      } catch (error) {
        attempt++;
        if (attempt > maxRetries) {
          this.logger.error(`操作 ${operationName} 失败，已达到最大重试次数`, { error });
          throw error;
        }

        const delay = Math.pow(2, attempt - 1) * 1000; // 1s, 2s, 4s
        this.logger.warn(`操作 ${operationName} 失败，将在 ${delay}ms 后重试 (${attempt}/${maxRetries})`, {
          error: (error as Error).message
        });

        await new Promise(resolve => setTimeout(resolve, delay));
      }
    }
  }

  private formatOrderParamsForLog(params: OrderParams): any {
    return {
      type: params.orderType,
      marketIndex: params.marketIndex,
      direction: params.direction,
      price: params.price.toString(),
      amount: params.baseAssetAmount.toString(),
      postOnly: params.postOnly,
      reduceOnly: params.reduceOnly
    };
  }
}
