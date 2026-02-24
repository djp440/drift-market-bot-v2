import { loadEnv } from "./env.js";
import { ConfigManager } from "./config/ConfigManager.js";
import { Logger } from "./logger/Logger.js";

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

configManager.on("configUpdated", (updatedConfig) => {
  logger.info("配置已更新", {
    market: updatedConfig.market,
    server: updatedConfig.server,
  });
});

configManager.watch();
