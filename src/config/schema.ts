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
        quote_source?: "oracle" | "orderbook";
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

const requireInteger = (value: unknown, name: string): number => {
    const numericValue = requireNumber(value, name);
    if (!Number.isInteger(numericValue)) {
        throw new Error(`配置项 ${name} 必须为整数`);
    }

    return numericValue;
};

const requireMin = (value: number, name: string, min: number): number => {
    if (value < min) {
        throw new Error(`配置项 ${name} 必须大于等于 ${min}`);
    }

    return value;
};

const requireRange = (value: number, name: string, min: number, max: number): number => {
    if (value < min || value > max) {
        throw new Error(`配置项 ${name} 必须在 ${min} 与 ${max} 之间`);
    }

    return value;
};

const validateConfig = (config: Config): void => {
    requireString(config.market?.pair, "market.pair");
    requireMin(requireInteger(config.market?.market_index, "market.market_index"), "market.market_index", 0);
    requireMin(requireNumber(config.market?.leverage, "market.leverage"), "market.leverage", 0.0000001);

    requireMin(requireNumber(config.order?.min_order_size, "order.min_order_size"), "order.min_order_size", 0.0000001);
    requireMin(requireNumber(config.order?.base_order_size, "order.base_order_size"), "order.base_order_size", 0.0000001);
    requireMin(requireNumber(config.order?.spread_bps, "order.spread_bps"), "order.spread_bps", 0);
    requireRange(requireNumber(config.order?.skew_factor, "order.skew_factor"), "order.skew_factor", 0, 1);
    if (config.order?.quote_source && config.order.quote_source !== "oracle" && config.order.quote_source !== "orderbook") {
        throw new Error("配置项 order.quote_source 必须为 'oracle' 或 'orderbook'");
    }

    requireBoolean(config.quoting?.post_only, "quoting.post_only");
    requireMin(requireNumber(config.quoting?.cancel_timeout_ms, "quoting.cancel_timeout_ms"), "quoting.cancel_timeout_ms", 0);
    requireRange(
        requireNumber(config.quoting?.price_refresh_threshold, "quoting.price_refresh_threshold"),
        "quoting.price_refresh_threshold",
        0,
        1
    );

    requireMin(requireNumber(config.risk?.max_position_size, "risk.max_position_size"), "risk.max_position_size", 0);
    requireMin(requireNumber(config.risk?.max_usdc_exposure, "risk.max_usdc_exposure"), "risk.max_usdc_exposure", 0);
    requireRange(requireNumber(config.risk?.emergency_stop_loss, "risk.emergency_stop_loss"), "risk.emergency_stop_loss", 0, 1);

    requireMin(
        requireNumber(config.database?.equity_snapshot_interval_sec, "database.equity_snapshot_interval_sec"),
        "database.equity_snapshot_interval_sec",
        1
    );

    const port = requireInteger(config.server?.port, "server.port");
    requireRange(port, "server.port", 1, 65535);
};

export type { Config };
export { validateConfig };
