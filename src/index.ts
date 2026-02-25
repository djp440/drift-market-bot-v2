import { loadEnv } from "./env.js";
import { ConfigManager } from "./config/ConfigManager.js";
import { Logger } from "./logger/Logger.js";
import { DriftClientWrapper } from "./drift/DriftClientWrapper.js";
import { OracleWatcher } from "./drift/OracleWatcher.js";
import { OrderExecutor } from "./drift/OrderExecutor.js";
import { BotEngine } from "./bot/BotEngine.js";

const logger = new Logger("Bootstrap");
const env = loadEnv();

logger.info("环境变量加载成功", {
  solanaRpcUrl: env.solanaRpcUrl,
  driftEnv: env.driftEnv,
  privateKeyLoaded: env.privateKey instanceof Uint8Array && env.privateKey.length === 64,
});

const configManager = ConfigManager.getInstance({ logger });
const config = await configManager.load();
logger.info("配置加载成功", {
  market: config.market,
  server: config.server,
});

// 初始化 DriftClientWrapper
const driftClientWrapper = new DriftClientWrapper(
  env.privateKey,
  env.solanaRpcUrl,
  env.driftEnv,
  new Logger("DriftClient")
);

// 初始化 OracleWatcher
const oracleWatcher = new OracleWatcher(
  driftClientWrapper.getConnection(),
  new Logger("OracleWatcher"),
  (marketIndex) => driftClientWrapper.getOraclePriceData(marketIndex),
  (marketIndex) => driftClientWrapper.getOraclePublicKey(marketIndex)
);

// 初始化 OrderExecutor
const orderExecutor = new OrderExecutor(
  driftClientWrapper.getDriftClient(),
  new Logger("OrderExecutor")
);

// 初始化 BotEngine
const botEngine = new BotEngine(
  driftClientWrapper,
  orderExecutor,
  oracleWatcher,
  configManager,
  new Logger("BotEngine")
);

// 启动 BotEngine
try {
  await botEngine.start();
  logger.info("BotEngine 已启动");
} catch (error) {
  logger.error("BotEngine 启动失败", error);
  process.exit(1);
}

// 监听配置更新
configManager.on("configUpdated", (updatedConfig) => {
  logger.info("配置已更新", {
    market: updatedConfig.market,
    server: updatedConfig.server,
  });
  // BotEngine 会自动处理配置更新吗？目前 BotEngine 似乎没有监听 configUpdated。
  // 根据需求 9.3.3 "BotEngine 监听 configUpdated 事件，动态更新参数"。
  // 目前 BotEngine 还没有实现这个，但那是后续阶段的任务。
  // 暂时保留日志。
});

configManager.watch();

// 优雅退出
const shutdown = async (signal: string) => {
  logger.info(`收到 ${signal} 信号，正在停止...`);
  try {
    await botEngine.stop();
    logger.info("BotEngine 已停止，程序退出");
    process.exit(0);
  } catch (error) {
    logger.error("停止过程中发生错误", error);
    process.exit(1);
  }
};

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// 全局异常捕获
process.on("uncaughtException", (error) => {
  logger.error("未捕获的异常", error);
  shutdown("uncaughtException");
});

process.on("unhandledRejection", (reason) => {
  logger.error("未处理的 Promise 拒绝", { reason });
});

