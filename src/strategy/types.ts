import { BN } from '@drift-labs/sdk';

/**
 * 持仓方向枚举
 * PositionSide Enum
 */
export enum PositionSide {
    LONG = 'LONG',
    SHORT = 'SHORT',
    NONE = 'NONE',
}

/**
 * 报价结果接口
 * QuoteResult Interface
 */
export interface QuoteResult {
    price: BN;
    size: BN;
    side: PositionSide;
    reduceOnly: boolean;
    oracleOffset: BN;
}

/**
 * 策略配置接口
 * StrategyConfig Interface
 */
export interface StrategyConfig {
    // 市场参数
    marketIndex: number;
    symbol: string;

    // 订单参数
    minOrderSize: BN;
    baseOrderSize: BN;
    spreadBps: number;
    skewFactor: number;

    // 风控参数
    maxPosition: BN;
}
