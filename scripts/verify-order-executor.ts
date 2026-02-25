import { loadEnv } from "../src/env.js";
import { DriftClientWrapper } from "../src/drift/DriftClientWrapper.js";
import { OrderExecutor } from "../src/drift/OrderExecutor.js";
import { Logger } from "../src/logger/Logger.js";
import { 
  OrderType, 
  PositionDirection, 
  PostOnlyParams, 
  BN, 
  BASE_PRECISION, 
  PRICE_PRECISION,
  QUOTE_PRECISION
} from "@drift-labs/sdk";
import { ConfigManager } from "../src/config/ConfigManager.js";

async function main() {
  const logger = new Logger("VerifyOrderExecutor");
  
  try {
    // 1. 加载环境和配置
    const env = loadEnv();
    const configManager = ConfigManager.getInstance({ logger });
    const config = await configManager.load();
    
    logger.info("环境加载成功", { driftEnv: env.driftEnv, rpc: env.solanaRpcUrl });

    // 2. 初始化 DriftClient
    const wrapper = new DriftClientWrapper(
      env.privateKey,
      env.solanaRpcUrl,
      env.driftEnv,
      logger
    );
    await wrapper.initialize();
    
    // 3. 获取账户信息和余额
    const userAccount = wrapper.getAccountInfo();
    if (!userAccount) {
      logger.error("未找到用户账户，请先存入资金并初始化账户");
      return;
    }
    
    const solBalance = await wrapper.getConnection().getBalance(wrapper.getDriftClient().wallet.publicKey);
    logger.info("SOL 余额", { sol: solBalance / 1e9 });
    
    // 4. 初始化 OrderExecutor
    const executor = new OrderExecutor(wrapper.getDriftClient(), logger);
    
    // 5. 获取 Oracle 价格
    const marketIndex = config.market.market_index;
    const oraclePriceData = wrapper.getOraclePriceData(marketIndex);
    const currentPrice = oraclePriceData.price.toNumber() / PRICE_PRECISION.toNumber();
    logger.info("当前预言机价格", { price: currentPrice });
    
    // 6. 准备下单参数 (买单，价格为当前价格的 50%，数量 0.1 SOL)
    const safePrice = currentPrice * 0.5;
    const priceBN = new BN(safePrice * PRICE_PRECISION.toNumber());
    const sizeBN = new BN(0.1 * BASE_PRECISION.toNumber());
    
    logger.info("准备下单", { 
      side: "LONG", 
      price: safePrice, 
      size: 0.1 
    });
    
    // 7. 执行下单
    await executor.placeOrder({
      marketIndex,
      orderType: OrderType.LIMIT,
      direction: PositionDirection.LONG,
      baseAssetAmount: sizeBN,
      price: priceBN,
      postOnly: PostOnlyParams.TRY_POST_ONLY,
    });
    
    // 8. 验证订单存在
    let openOrders = executor.getOpenOrders();
    logger.info("当前挂单数量", { count: openOrders.length });
    
    if (openOrders.length === 0) {
      throw new Error("下单失败，未找到挂单");
    }
    
    const firstOrderId = openOrders[0].orderId.toString();
    logger.info("下单成功", { orderId: firstOrderId });
    
    // 9. 原子撤单并下单 (修改数量为 0.11 SOL)
    const newSizeBN = new BN(0.11 * BASE_PRECISION.toNumber());
    logger.info("执行原子撤单并下单", { newSize: 0.11 });
    
    await executor.cancelAndReplace(
      [firstOrderId],
      [{
        marketIndex,
        orderType: OrderType.LIMIT,
        direction: PositionDirection.LONG,
        baseAssetAmount: newSizeBN,
        price: priceBN,
        postOnly: PostOnlyParams.TRY_POST_ONLY,
      }]
    );
    
    // 10. 验证新订单
    // 等待一点时间让状态更新 (虽然 SDK 应该更新了)
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    openOrders = executor.getOpenOrders();
    logger.info("原子操作后挂单数量", { count: openOrders.length });
    
    if (openOrders.length !== 1) {
      logger.warn("挂单数量不符合预期", { expected: 1, actual: openOrders.length });
    } else {
      const newOrder = openOrders[0];
      const newSize = newOrder.baseAssetAmount.toNumber() / BASE_PRECISION.toNumber();
      logger.info("新订单详情", { 
        orderId: newOrder.orderId.toString(),
        size: newSize
      });
      
      if (Math.abs(newSize - 0.11) > 0.0001) {
        logger.warn("新订单数量不匹配", { expected: 0.11, actual: newSize });
      } else {
        logger.info("原子撤单下单验证成功");
      }
    }
    
    // 11. 撤销所有订单
    logger.info("撤销所有订单");
    await executor.cancelAllOrders(marketIndex);
    
    // 12. 验证无挂单
    await new Promise(resolve => setTimeout(resolve, 2000));
    openOrders = executor.getOpenOrders();
    logger.info("最终挂单数量", { count: openOrders.length });
    
    if (openOrders.length === 0) {
      logger.info("所有测试通过！");
    } else {
      logger.error("撤单失败，仍有挂单");
    }

  } catch (error) {
    logger.error("测试过程中发生错误", error as Error);
    process.exit(1);
  } finally {
    // 确保清理
    logger.info("测试结束");
    process.exit(0);
  }
}

main();
