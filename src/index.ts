import { loadEnv } from "./env.js";
import { ConfigManager } from "./config/ConfigManager.js";
import { Logger } from "./logger/Logger.js";
import { DriftClientWrapper } from "./drift/DriftClientWrapper.js";
import { OracleWatcher } from "./drift/OracleWatcher.js";

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

await driftClientWrapper.initialize();

// 初始化 OracleWatcher
const oracleWatcher = new OracleWatcher(
  driftClientWrapper.getConnection(),
  new Logger("OracleWatcher"),
  (marketIndex) => driftClientWrapper.getOraclePriceData(marketIndex)
);

// 启动预言机监听
oracleWatcher.start(config.market.market_index);

// 订阅账户更新
driftClientWrapper.subscribe((account) => {
  logger.info("账户已更新", {
    authority: account.authority.toBase58(),
    subAccountId: account.subAccountId,
  });
});

// 监听价格变化
oracleWatcher.onPriceUpdate(config.market.market_index, (price) => {
  logger.info("预言机价格更新", {
    market: config.market.pair,
    price: price.toString(),
  });
});

configManager.on("configUpdated", (updatedConfig) => {
  logger.info("配置已更新", {
    market: updatedConfig.market,
    server: updatedConfig.server,
  });

  // 如果市场索引变了，重启预言机监听
  if (updatedConfig.market.market_index !== config.market.market_index) {
    oracleWatcher.stop(config.market.market_index);
    oracleWatcher.start(updatedConfig.market.market_index);
  }
});

configManager.watch();
