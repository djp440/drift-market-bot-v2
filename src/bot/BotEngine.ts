import { DriftClientWrapper } from "../drift/DriftClientWrapper.js";
import { OrderExecutor } from "../drift/OrderExecutor.js";
import { OracleWatcher } from "../drift/OracleWatcher.js";
import { Strategy } from "../strategy/Strategy.js";
import { ConfigManager } from "../config/ConfigManager.js";
import { Logger } from "../logger/Logger.js";
import { EventHandler } from "./EventHandler.js";
import {
  BN,
  Order,
  PositionDirection,
  PostOnlyParams,
  OrderType,
  isVariant,
  OrderActionRecord,
  BASE_PRECISION,
  OrderParams,
  MarketType
} from "@drift-labs/sdk";
import { StrategyConfig } from "../strategy/types.js";

export enum BotState {
  IDLE = 'IDLE',
  STARTUP = 'STARTUP',
  MARKET_MAKING = 'MARKET_MAKING'
}

export class BotEngine {
  private driftClientWrapper: DriftClientWrapper;
  private orderExecutor: OrderExecutor;
  private oracleWatcher: OracleWatcher;
  private strategy: Strategy;
  private configManager: ConfigManager;
  private logger: Logger;
  private eventHandler: EventHandler;

  private currentState: BotState = BotState.IDLE;
  private isRunning: boolean = false;
  private isProcessing: boolean = false;
  private marketIndex: number;

  // State variables
  private currentPosition: BN = new BN(0);
  private currentOraclePrice: BN = new BN(0);
  private lastOrderTime: number = 0;
  private isWaitingForOrderUpdate: boolean = false;
  private waitingStartTime: number = 0;

  // Timer for loop
  private loopTimer: NodeJS.Timeout | null = null;
  private readonly LOOP_INTERVAL = 10000; // 10s loop for heartbeat/recovery only
  private readonly ORDER_COOLDOWN = 5000; // 5s cooldown after placing orders

  constructor(
    driftClientWrapper: DriftClientWrapper,
    orderExecutor: OrderExecutor,
    oracleWatcher: OracleWatcher,
    configManager: ConfigManager,
    logger: Logger
  ) {
    this.driftClientWrapper = driftClientWrapper;
    this.orderExecutor = orderExecutor;
    this.oracleWatcher = oracleWatcher;
    this.configManager = configManager;
    this.logger = logger;

    const config = this.configManager.get();
    this.marketIndex = config.market.market_index;

    const strategyConfig: StrategyConfig = {
      marketIndex: this.marketIndex,
      symbol: config.market.pair,
      minOrderSize: new BN(config.order.min_order_size * BASE_PRECISION.toNumber()),
      baseOrderSize: new BN(config.order.base_order_size * BASE_PRECISION.toNumber()),
      spreadBps: config.order.spread_bps,
      skewFactor: config.order.skew_factor,
      quoteSource: config.order.quote_source as 'oracle' | 'orderbook',
      maxPosition: new BN(config.risk.max_position_size * BASE_PRECISION.toNumber())
    };
    this.strategy = new Strategy(strategyConfig);

    this.eventHandler = new EventHandler(this, this.logger);
  }

  public async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn("BotEngine 已经在运行中");
      return;
    }

    this.logger.info("正在启动 BotEngine...");
    this.isRunning = true;

    // 初始化 DriftClient
    await this.driftClientWrapper.initialize();

    // 如果启用了 orderbook 报价源，初始化 DLOBClient
    const config = this.configManager.get();
    if (config.order.quote_source === 'orderbook') {
      this.driftClientWrapper.initializeDLOBClient(this.marketIndex, config.market.pair);
    }

    // 订阅预言机
    this.oracleWatcher.addCallback(this.marketIndex, (price) => {
      this.eventHandler.onOracleUpdate(price);
    });
    this.oracleWatcher.start(this.marketIndex);

    // 订阅账户变更
    await this.driftClientWrapper.subscribe((account) => {
      this.eventHandler.onPositionChange();
    });

    // 订阅订单成交事件
    this.driftClientWrapper.subscribeOrderFill((record) => {
      this.eventHandler.onOrderFill(record);
    });

    // 订阅订单取消事件
    this.driftClientWrapper.subscribeOrderCancel((record) => {
      this.eventHandler.onOrderCancel(record);
    });

    // 初始状态同步
    await this.syncState();

    // 启动主循环
    this.loopTimer = setInterval(() => this.runLoop(), this.LOOP_INTERVAL);

    this.currentState = BotState.STARTUP;
    this.logger.info("BotEngine 启动完成，进入 STARTUP 状态");
  }

  public async stop(): Promise<void> {
    this.logger.info("正在停止 BotEngine...");
    this.isRunning = false;
    this.currentState = BotState.IDLE;

    if (this.loopTimer) {
      clearInterval(this.loopTimer);
      this.loopTimer = null;
    }

    // 停止预言机监听
    this.oracleWatcher.stop(this.marketIndex);

    // 取消所有订单
    // 必须在 unsubscribe 之前执行，因为 SDK 内部依赖订阅状态
    try {
      this.logger.info("正在撤销所有订单...");
      await this.orderExecutor.cancelAllOrders(this.marketIndex);
      this.logger.info("所有订单已撤销");
    } catch (error) {
      this.logger.error("停止时撤单失败", error);
    }

    // 最后取消订阅
    await this.driftClientWrapper.unsubscribe();

    this.logger.info("BotEngine 已停止");
  }

  private async runLoop(): Promise<void> {
    if (!this.isRunning) return;
    if (this.isProcessing) {
      // this.logger.debug("上一次循环尚未结束，跳过本次循环");
      return;
    }

    this.isProcessing = true;
    try {
      await this.syncState();

      switch (this.currentState) {
        case BotState.STARTUP:
          await this.runStartupMode();
          break;
        case BotState.MARKET_MAKING:
          await this.runMarketMakingMode();
          break;
        case BotState.IDLE:
        default:
          break;
      }
    } catch (error) {
      this.logger.error("主循环执行出错", error);
    } finally {
      this.isProcessing = false;
    }
  }

  public async syncState(): Promise<void> {
    // 同步仓位
    const position = await this.driftClientWrapper.getPosition(this.marketIndex);
    this.currentPosition = position.side === 'short' ? position.size.neg() : position.size;

    // 同步预言机价格
    this.currentOraclePrice = await this.driftClientWrapper.getOraclePrice(this.marketIndex);

    // 如果配置了 orderbook 报价源，则获取 L1 价格（预留，目前 DriftClientWrapper 尚未完全支持 L2）
    // 目前 Strategy 仍然依赖 oraclePrice 作为输入，后续可以在 calculateSpread 中传入更多参数
  }

  private async runStartupMode(): Promise<void> {
    // 检查下单冷却
    if (Date.now() - this.lastOrderTime < this.ORDER_COOLDOWN) {
      return;
    }

    if (this.currentPosition.abs().gt(new BN(0))) {
      this.logger.info("检测到持仓，切换至做市模式", { position: this.currentPosition.toString() });
      this.currentState = BotState.MARKET_MAKING;
      return;
    }

    // 无仓位，挂买单
    const openOrders = await this.orderExecutor.getOpenOrders(this.marketIndex);
    if (openOrders.length === 0) {
      const { bidSize } = this.strategy.calculateOrderSize(this.currentPosition);
      const { bidSpread } = this.strategy.calculateSpread(this.currentOraclePrice, this.currentPosition);
      const price = this.currentOraclePrice.sub(bidSpread);

      this.logger.info("启动模式：挂买单", { price: price.toString(), size: bidSize.toString() });
      this.lastOrderTime = Date.now(); // 提前更新时间
      try {
        await this.placeBidOrder(price, bidSize);
      } catch (error) {
        this.logger.error("启动模式挂单失败", error);
      }
    } else {
      // 检查超时
      await this.checkTimeoutAndReposition(openOrders[0]);
    }
  }

  private async runMarketMakingMode(): Promise<void> {
    // 检查下单冷却
    if (Date.now() - this.lastOrderTime < this.ORDER_COOLDOWN) {
      // this.logger.debug("下单冷却中", { lastOrderTime: this.lastOrderTime, now: Date.now() });
      return;
    }

    // 获取当前挂单
    const openOrders = await this.orderExecutor.getOpenOrders(this.marketIndex);

    // 检查是否在等待订单状态同步
    if (this.isWaitingForOrderUpdate) {
      if (openOrders.length === 0) {
        this.logger.info("订单状态已同步，恢复做市");
        this.isWaitingForOrderUpdate = false;
      } else {
        if (Date.now() - this.waitingStartTime > 5000) {
          this.logger.warn("等待订单状态同步超时，强制恢复做市", { openOrders: openOrders.length });
          this.isWaitingForOrderUpdate = false;
        } else {
          this.logger.debug("等待订单状态同步...", { currentCount: openOrders.length });
          return;
        }
      }
    }

    // 纯事件驱动模式：如果已有双向挂单，则直接返回，不进行轮询更新
    // 只有在订单成交/取消后，或者挂单不全时才进行操作
    const bidOrder = openOrders.find(o => isVariant(o.direction, 'long'));
    const askOrder = openOrders.find(o => isVariant(o.direction, 'short'));

    // 计算报价
    // 决定中间价来源
    let midPrice = this.currentOraclePrice;
    if (this.strategy.getConfig().quoteSource === 'orderbook') {
      const bestBidAsk = await this.driftClientWrapper.getBestBidAsk(this.marketIndex);
      if (bestBidAsk) {
        // mid = (bestBid + bestAsk) / 2
        midPrice = bestBidAsk.bestBid.add(bestBidAsk.bestAsk).div(new BN(2));
        // 确保 midPrice 有效，如果 orderbook 异常，回退到 oracle
        if (midPrice.isZero()) {
          this.logger.warn("Orderbook 中间价为 0，回退到预言机价格");
          midPrice = this.currentOraclePrice;
        }
      } else {
        // 获取失败，回退到 Oracle
        // this.logger.debug("无法获取 L1 Orderbook，使用预言机价格");
        midPrice = this.currentOraclePrice;
      }
    }

    const { bidSize, askSize } = this.strategy.calculateOrderSize(this.currentPosition);
    // 传入 midPrice 作为基准价格计算 spread
    const { bidSpread, askSpread, debug } = this.strategy.calculateSpread(midPrice, this.currentPosition);
    const bidPrice = midPrice.sub(bidSpread);
    const askPrice = midPrice.add(askSpread);

    // 调试日志
    this.logger.debug("做市状态检查", {
      openOrders: openOrders.length,
      bidOrder: bidOrder ? "exists" : "missing",
      askOrder: askOrder ? "exists" : "missing",
      bidSize: bidSize.toString(),
      askSize: askSize.toString(),
      bidPrice: bidPrice.toString(),
      askPrice: askPrice.toString(),
      midPrice: midPrice.toString(),
      quoteSource: this.strategy.getConfig().quoteSource
    });

    const newOrders: OrderParams[] = [];
    // 使用 cancelAndReplace 的 cancelOrderIds 参数，而不是单独调用 cancel
    const cancelIds: string[] = [];

    // 检查是否需要强制重置（任一方向订单缺失，且策略要求挂单）
    // 如果是，为了保证对称性和价格新鲜度，我们撤销所有存量订单并重新挂出双向订单
    // 这样可以避免“单边滞留”和“价格脱节”
    const needBid = bidSize.gt(new BN(0));
    const needAsk = this.currentPosition.gt(new BN(0)) && askSize.gt(new BN(0));
    const missingBid = needBid && !bidOrder;
    const missingAsk = needAsk && !askOrder;

    if (missingBid || missingAsk) {
      this.logger.info("检测到订单缺失，执行强制双向重置", { missingBid, missingAsk });

      // 1. 标记所有现有订单为待撤销
      if (bidOrder) cancelIds.push(bidOrder.orderId.toString());
      if (askOrder) cancelIds.push(askOrder.orderId.toString());

      // 2. 重新挂出双向订单（如果需要）
      if (needBid) {
        newOrders.push(this.createOrderParams(bidPrice, bidSize, PositionDirection.LONG));
      }
      if (needAsk) {
        newOrders.push(this.createOrderParams(askPrice, askSize, PositionDirection.SHORT, true));
      }
    } else {
      // 双方订单都存在，或者不需要挂单
      // 检查是否有“多余”的订单（例如仓位归零后，卖单仍存在）
      if (!needBid && bidOrder) {
        this.logger.debug("检测到多余买单，准备撤销");
        cancelIds.push(bidOrder.orderId.toString());
      }
      if (!needAsk && askOrder) {
        this.logger.debug("检测到多余卖单，准备撤销");
        cancelIds.push(askOrder.orderId.toString());
      }

      // 检查现有订单是否严重偏离策略（价格或数量）
      // 即使在纯事件驱动模式下，如果订单确实存在但严重不符，也应该更新
      // 这可以作为一种被动防御机制，防止过期订单长期滞留
      if (bidOrder && needBid && this.shouldUpdateOrder(bidOrder, bidPrice, bidSize)) {
        this.logger.debug("现有买单偏离策略，准备更新");
        cancelIds.push(bidOrder.orderId.toString());
        newOrders.push(this.createOrderParams(bidPrice, bidSize, PositionDirection.LONG));
      }
      if (askOrder && needAsk && this.shouldUpdateOrder(askOrder, askPrice, askSize)) {
        this.logger.debug("现有卖单偏离策略，准备更新");
        cancelIds.push(askOrder.orderId.toString());
        newOrders.push(this.createOrderParams(askPrice, askSize, PositionDirection.SHORT, true));
      }
    }

    // 只有在确实需要挂新单（补单）或者有订单需要撤销更新时才执行
    if (newOrders.length > 0 || cancelIds.length > 0) {
      this.logger.info("执行做市订单调整", {
        cancelCount: cancelIds.length,
        newOrderCount: newOrders.length,
        strategyDetails: {
          oraclePrice: this.currentOraclePrice.toString(),
          midPrice: midPrice.toString(),
          position: this.currentPosition.toString(),
          bidSize: bidSize.toString(),
          askSize: askSize.toString(),
          bidPrice: bidPrice.toString(),
          askPrice: askPrice.toString(),
          bidSpread: bidSpread.toString(),
          askSpread: askSpread.toString(),
          skewFactor: this.strategy.getConfig().skewFactor,
          quoteSource: this.strategy.getConfig().quoteSource,
          debug
        }
      });

      this.lastOrderTime = Date.now();
      try {
        await this.orderExecutor.cancelAndReplace(cancelIds, newOrders);
      } catch (error) {
        this.logger.error("订单调整失败", error);
      }
    }
  }

  private shouldUpdateOrder(order: Order, targetPrice: BN, targetSize?: BN): boolean {
    const currentPrice = order.price;
    const priceDiff = currentPrice.sub(targetPrice).abs();
    const threshold = targetPrice.mul(new BN(50)).div(new BN(10000)); // 0.5% diff

    let isSizeChanged = false;
    if (targetSize) {
      const currentSize = order.baseAssetAmount;
      const sizeDiff = currentSize.sub(targetSize).abs();
      // 如果数量变化超过 10% (0.1)
      const sizeThreshold = currentSize.div(new BN(10));
      isSizeChanged = sizeDiff.gt(sizeThreshold);
    }

    // 超时检查
    const isTimeout = Date.now() - this.lastOrderTime > 30000; // 30s

    return priceDiff.gt(threshold) || isSizeChanged || isTimeout;
  }

  private createOrderParams(price: BN, size: BN, direction: PositionDirection, reduceOnly: boolean = false): OrderParams {
    return {
      marketIndex: this.marketIndex,
      orderType: OrderType.LIMIT,
      marketType: MarketType.PERP,
      direction,
      baseAssetAmount: size,
      price,
      postOnly: PostOnlyParams.TRY_POST_ONLY,
      reduceOnly
    } as unknown as OrderParams;
  }

  public async placeBidOrder(price: BN, size: BN): Promise<void> {
    const params = this.createOrderParams(price, size, PositionDirection.LONG);
    await this.orderExecutor.placeOrder(params);
  }

  public async placeAskOrder(price: BN, size: BN, reduceOnly: boolean = true): Promise<void> {
    const params = this.createOrderParams(price, size, PositionDirection.SHORT, reduceOnly);
    await this.orderExecutor.placeOrder(params);
  }



  public async checkTimeoutAndReposition(order: Order): Promise<void> {
    if (Date.now() - this.lastOrderTime > 30000) {
      this.logger.info("订单超时，准备重置", { orderId: order.orderId.toString() });
      await this.orderExecutor.cancelOrder(order.orderId.toString());
    }
  }

  // Event Handlers
  public async handleOrderFill(record: OrderActionRecord): Promise<void> {
    this.logger.info("检测到订单成交", {
      ts: record.ts.toString(),
      marketIndex: record.marketIndex
    });

    // 立即重置冷却时间，允许尽快响应
    this.lastOrderTime = 0;

    // 设置“等待同步”标志，防止在撤单完成前过早挂单
    // 但这个标志会在 runMarketMakingMode 中被处理（如果订单列表为空则清除）
    this.isWaitingForOrderUpdate = true;
    this.waitingStartTime = Date.now();

    // 触发原子清理：撤销剩余所有挂单
    // 我们不需要等待这个 Promise 完成才去同步状态，可以并行
    this.orderExecutor.cancelAllOrders(this.marketIndex).catch(err => {
      this.logger.error("订单成交后撤单失败", err);
    });

    // 立即同步状态（余额、仓位）
    await this.syncState();

    // 触发主循环，runMarketMakingMode 会检查 isWaitingForOrderUpdate
    // 如果 cancelAllOrders 还没完成，runLoop 会检测到 openOrders 还没清空，从而等待
    // 如果 cancelAllOrders 完成了，openOrders 为空，runLoop 会立即挂新单
    this.runLoop();
  }

  public async handleOrderCancel(record: OrderActionRecord): Promise<void> {
    // 订单取消后，可能是主动撤单，也可能是被动撤单（如 IOC/Fill）
    // 如果处于等待订单更新的状态（通常是因为正在进行主动清理或原子撤单），
    // 那么这个撤单事件是预期的，我们不需要做额外的处理，也不需要打印日志刷屏
    if (this.isWaitingForOrderUpdate) {
      // this.logger.debug("忽略主动撤单事件", { ts: record.ts.toString() });
      return;
    }

    this.logger.info("检测到意外订单取消", {
      ts: record.ts.toString(),
      marketIndex: record.marketIndex
    });

    // 我们需要重新评估挂单状态
    await this.syncState();

    // 立即触发循环以补单
    this.runLoop();
  }

  public async handlePositionChange(): Promise<void> {
    const oldPosition = this.currentPosition;
    await this.syncState(); // 更新 this.currentPosition

    if (!this.currentPosition.eq(oldPosition)) {
      this.logger.info("仓位发生变化", {
        old: oldPosition.toString(),
        new: this.currentPosition.toString()
      });
      // 在纯事件驱动模式下，不需要在这里重置冷却或触发 runLoop
      // 因为 handleOrderFill 会负责处理成交后的逻辑
      // handlePositionChange 主要作为状态同步的兜底
    }

    // 移除 runLoop()，避免与 handleOrderFill/handleOrderCancel 冲突导致重复挂单
    // this.runLoop();
  }

  public handleOracleUpdate(price: BN): void {
    this.currentOraclePrice = price;
    // 不再在预言机更新时触发 runLoop，仅更新内存价格
    // 除非在 Startup 模式且需要尽快下单
    if (this.currentState === BotState.STARTUP) {
      this.runLoop();
    }
  }
}
