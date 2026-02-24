import fs from "node:fs/promises";
import path from "node:path";
import toml from "@iarna/toml";

type Config = {
  market: {
    pair: string;
    market_index: number;
    leverage: number;
  };
  order: {
    min_order_size: number;
    base_order_size: number;
    spread_bps: number;
    skew_factor: number;
  };
  quoting: {
    post_only: boolean;
    cancel_timeout_ms: number;
    price_refresh_threshold: number;
  };
  risk: {
    max_position_size: number;
    max_usdc_exposure: number;
    emergency_stop_loss: number;
  };
  database: {
    equity_snapshot_interval_sec: number;
  };
  server: {
    port: number;
  };
};

const requireString = (value: unknown, name: string): string => {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`配置项 ${name} 必须为非空字符串`);
  }

  return value;
};

const requireNumber = (value: unknown, name: string): number => {
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new Error(`配置项 ${name} 必须为数字`);
  }

  return value;
};

const requireBoolean = (value: unknown, name: string): boolean => {
  if (typeof value !== "boolean") {
    throw new Error(`配置项 ${name} 必须为布尔值`);
  }

  return value;
};

const validateConfig = (config: Config): void => {
  requireString(config.market?.pair, "market.pair");
  requireNumber(config.market?.market_index, "market.market_index");
  requireNumber(config.market?.leverage, "market.leverage");

  requireNumber(config.order?.min_order_size, "order.min_order_size");
  requireNumber(config.order?.base_order_size, "order.base_order_size");
  requireNumber(config.order?.spread_bps, "order.spread_bps");
  requireNumber(config.order?.skew_factor, "order.skew_factor");

  requireBoolean(config.quoting?.post_only, "quoting.post_only");
  requireNumber(config.quoting?.cancel_timeout_ms, "quoting.cancel_timeout_ms");
  requireNumber(config.quoting?.price_refresh_threshold, "quoting.price_refresh_threshold");

  requireNumber(config.risk?.max_position_size, "risk.max_position_size");
  requireNumber(config.risk?.max_usdc_exposure, "risk.max_usdc_exposure");
  requireNumber(config.risk?.emergency_stop_loss, "risk.emergency_stop_loss");

  requireNumber(config.database?.equity_snapshot_interval_sec, "database.equity_snapshot_interval_sec");

  requireNumber(config.server?.port, "server.port");
};

export const loadConfig = async (configPath?: string): Promise<Config> => {
  const targetPath = configPath ?? path.resolve(process.cwd(), "config.toml");
  const content = await fs.readFile(targetPath, "utf-8");
  const parsed = toml.parse(content) as Config;
  validateConfig(parsed);
  return parsed;
};

export type { Config };
