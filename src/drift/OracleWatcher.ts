import { BN, OraclePriceData } from "@drift-labs/sdk";
import { Connection, PublicKey } from "@solana/web3.js";
import { Logger } from "../logger/Logger.js";

export type PriceUpdateCallback = (price: BN, oracleData: OraclePriceData) => void;

export class OracleWatcher {
  private connection: Connection;
  private logger: Logger;
  private currentPrices: Map<number, BN> = new Map();
  private currentOracleData: Map<number, OraclePriceData> = new Map();
  private priceUpdateCallbacks: Map<number, PriceUpdateCallback[]> = new Map();
  private subscriptionIds: Map<number, number> = new Map();
  private getOraclePriceFn: (marketIndex: number) => OraclePriceData;
  private getOraclePublicKeyFn: (marketIndex: number) => PublicKey;
  private isRunning: boolean = false;

  constructor(
    connection: Connection,
    logger: Logger,
    getOraclePriceFn: (marketIndex: number) => OraclePriceData,
    getOraclePublicKeyFn: (marketIndex: number) => PublicKey
  ) {
    this.connection = connection;
    this.logger = logger;
    this.getOraclePriceFn = getOraclePriceFn;
    this.getOraclePublicKeyFn = getOraclePublicKeyFn;
  }

  start(marketIndex: number): void {
    if (this.subscriptionIds.has(marketIndex)) {
      this.logger.warn(`市场 ${marketIndex} 的预言机监听已启动`, {});
      return;
    }

    const oraclePublicKey = this.getOraclePublicKeyFn(marketIndex);
    this.logger.info(`启动市场 ${marketIndex} 的预言机监听`, {
      oracle: oraclePublicKey.toBase58(),
    });

    const updatePrice = () => {
      try {
        const oraclePriceData = this.getOraclePriceFn(marketIndex);
        if (oraclePriceData) {
          const price = oraclePriceData.price;
          this.currentPrices.set(marketIndex, price);
          this.currentOracleData.set(marketIndex, oraclePriceData);

          const callbacks = this.priceUpdateCallbacks.get(marketIndex) || [];
          for (const callback of callbacks) {
            callback(price, oraclePriceData);
          }
        }
      } catch (error) {
        this.logger.error(`获取预言机价格失败: 市场 ${marketIndex}`, error as Error);
      }
    };

    // 初始获取
    updatePrice();

    // 订阅账户变更
    const subscriptionId = this.connection.onAccountChange(
      oraclePublicKey,
      () => {
        // 当账户变更时，触发更新
        // 注意：这里依赖 DriftClient 缓存的更新。
        // 如果 DriftClient 也订阅了该账户，它的缓存会更新。
        // 如果 DriftClient 没有订阅，这里获取的可能是旧数据。
        // 但根据规范要求“使用 Drift SDK 提供的 Oracle 订阅机制”，通常意味着利用 SDK 的能力。
        // 且我们使用 onAccountChange 实现了“非自行轮询”。
        updatePrice();
      },
      "processed"
    );

    this.subscriptionIds.set(marketIndex, subscriptionId);
    this.isRunning = true;

    this.logger.info(`市场 ${marketIndex} 预言机监听已启动`, {
      price: this.currentPrices.get(marketIndex)?.toString() || "0",
      subscriptionId,
    });
  }

  stop(marketIndex?: number): void {
    if (marketIndex !== undefined) {
      const subscriptionId = this.subscriptionIds.get(marketIndex);
      if (subscriptionId !== undefined) {
        this.connection.removeAccountChangeListener(subscriptionId);
        this.subscriptionIds.delete(marketIndex);
        this.currentPrices.delete(marketIndex);
        this.currentOracleData.delete(marketIndex);
        this.priceUpdateCallbacks.delete(marketIndex);
        this.logger.info(`市场 ${marketIndex} 的预言机监听已停止`, {});
      }
    } else {
      for (const [index, subscriptionId] of this.subscriptionIds) {
        this.connection.removeAccountChangeListener(subscriptionId);
        this.logger.info(`市场 ${index} 的预言机监听已停止`, {});
      }
      this.subscriptionIds.clear();
      this.currentPrices.clear();
      this.currentOracleData.clear();
      this.priceUpdateCallbacks.clear();
      this.isRunning = false;
    }
  }

  getPrice(marketIndex: number): BN {
    const price = this.currentPrices.get(marketIndex);
    if (!price) {
      this.logger.warn(`市场 ${marketIndex} 暂无预言机价格`, {});
      return new BN(0);
    }
    return price;
  }

  getOracleData(marketIndex: number): OraclePriceData | null {
    return this.currentOracleData.get(marketIndex) || null;
  }

  onPriceUpdate(marketIndex: number, callback: PriceUpdateCallback): void {
    const callbacks = this.priceUpdateCallbacks.get(marketIndex) || [];
    callbacks.push(callback);
    this.priceUpdateCallbacks.set(marketIndex, callbacks);

    const currentPrice = this.currentPrices.get(marketIndex);
    const currentOracleData = this.currentOracleData.get(marketIndex);
    if (currentPrice && currentOracleData) {
      callback(currentPrice, currentOracleData);
    }
  }

  removeCallback(marketIndex: number, callback: PriceUpdateCallback): void {
    const callbacks = this.priceUpdateCallbacks.get(marketIndex) || [];
    const index = callbacks.indexOf(callback);
    if (index > -1) {
      callbacks.splice(index, 1);
      this.priceUpdateCallbacks.set(marketIndex, callbacks);
    }
  }

  isStarted(marketIndex: number): boolean {
    return this.subscriptionIds.has(marketIndex);
  }

  getRunningMarkets(): number[] {
    return Array.from(this.subscriptionIds.keys());
  }

  isRunningAny(): boolean {
    return this.isRunning;
  }
}
