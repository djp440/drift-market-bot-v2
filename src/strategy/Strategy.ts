import { BN, PRICE_PRECISION, BASE_PRECISION } from '@drift-labs/sdk';
import { StrategyConfig, QuoteResult, PositionSide } from './types';

/**
 * 库存感知报价策略
 * Inventory Aware Quoting Strategy
 */
export class Strategy {
	private config: StrategyConfig;

	constructor(config: StrategyConfig) {
		this.config = config;
	}

	/**
	 * 计算买卖价差
	 * Calculate Bid/Ask Spread based on inventory
	 * @param oraclePrice 预言机价格
	 * @param currentPosition 当前持仓
	 * @returns { bidSpread: BN, askSpread: BN }
	 */
	public calculateSpread(
		oraclePrice: BN,
		currentPosition: BN
	): { bidSpread: BN; askSpread: BN } {
		// 基础价差的一半 (Base Half Spread)
		// spreadBps is in basis points (1/10000)
		// spread = price * spreadBps / 10000
		// half_spread = spread / 2
		const spreadAmount = oraclePrice.mul(new BN(this.config.spreadBps)).div(new BN(10000));
		const baseHalfSpread = spreadAmount.div(new BN(2));

		// 计算库存偏移
		// skew = (currentPosition / maxPosition) * skewFactor
		// skewAmount = baseHalfSpread * skew

		// Avoid division by zero
		if (this.config.maxPosition.isZero()) {
			return {
				bidSpread: baseHalfSpread,
				askSpread: baseHalfSpread,
			};
		}

		// 使用高精度计算库存比例
		// inventoryRatio = (currentPosition * 10000) / maxPosition
		// We use 10000 as a scaling factor for precision (similar to BPS)
		const SCALING_FACTOR = new BN(10000);
		
		// currentPosition and maxPosition are in BASE_PRECISION
		const inventoryRatio = currentPosition.mul(SCALING_FACTOR).div(this.config.maxPosition);

		// skewFactor is a number, convert to scaled BN (e.g. 0.5 -> 5000)
		const skewFactorScaled = new BN(Math.floor(this.config.skewFactor * 10000));

		// skewRatio = inventoryRatio * skewFactor
		// This results in a value scaled by 10000 * 10000
		const skewRatio = inventoryRatio.mul(skewFactorScaled);

		// spreadAdjustment = baseHalfSpread * skewRatio / (10000 * 10000)
		const spreadAdjustment = baseHalfSpread.mul(skewRatio).div(SCALING_FACTOR.mul(SCALING_FACTOR));

		// 当持有多头 (currentPosition > 0) -> inventoryRatio > 0 -> spreadAdjustment > 0
		// bidSpread = base + adj (Buy lower)
		// askSpread = base - adj (Sell lower/closer)
		const bidSpread = baseHalfSpread.add(spreadAdjustment);
		const askSpread = baseHalfSpread.sub(spreadAdjustment);

		// 确保 spread 不小于 0 (防止交叉)
		// Ensure spreads are not negative
		const finalBidSpread = bidSpread.lt(new BN(0)) ? new BN(0) : bidSpread;
		const finalAskSpread = askSpread.lt(new BN(0)) ? new BN(0) : askSpread;

		return {
			bidSpread: finalBidSpread,
			askSpread: finalAskSpread,
		};
	}

	/**
	 * 计算下单数量
	 * Calculate Order Size
	 * @param currentPosition 当前持仓
	 * @returns { bidSize: BN, askSize: BN }
	 */
	public calculateOrderSize(
		currentPosition: BN
	): { bidSize: BN; askSize: BN } {
		// 基础下单数量
		let bidSize = this.config.baseOrderSize;
		let askSize = this.config.baseOrderSize;

		// 检查最大持仓限制
		// Check max position limits
		const maxPos = this.config.maxPosition;

		// 如果当前持仓接近最大多头持仓，减少买单数量或停止买入
		// If current position + bidSize > maxPos, clamp bidSize
		const potentialLongPos = currentPosition.add(bidSize);
		if (potentialLongPos.gt(maxPos)) {
			// 剩余可买数量
			const remainingBuy = maxPos.sub(currentPosition);
			bidSize = remainingBuy.gt(new BN(0)) ? remainingBuy : new BN(0);
		}

		// 如果当前持仓接近最大空头持仓 (负数)，减少卖单数量或停止卖出
		// If current position - askSize < -maxPos, clamp askSize
		const negMaxPos = maxPos.neg();
		const potentialShortPos = currentPosition.sub(askSize);
		if (potentialShortPos.lt(negMaxPos)) {
			// 剩余可卖数量 (current - (-max)) = current + max
			const remainingSell = currentPosition.sub(negMaxPos);
			askSize = remainingSell.gt(new BN(0)) ? remainingSell : new BN(0);
		}
        
        // 检查最小下单数量
        if (bidSize.lt(this.config.minOrderSize)) {
            bidSize = new BN(0);
        }
        if (askSize.lt(this.config.minOrderSize)) {
            askSize = new BN(0);
        }

		return { bidSize, askSize };
	}

	/**
	 * 计算买卖报价
	 * Calculate Bid/Ask Quotes
	 * @param oraclePrice 预言机价格
	 * @param currentPosition 当前持仓
	 * @returns { bid: QuoteResult, ask: QuoteResult }
	 */
	public calculateBidAsk(
		oraclePrice: BN,
		currentPosition: BN
	): { bid: QuoteResult; ask: QuoteResult } {
		const { bidSpread, askSpread } = this.calculateSpread(oraclePrice, currentPosition);
		const { bidSize, askSize } = this.calculateOrderSize(currentPosition);

		// Bid Price = Oracle Price - Bid Spread
		const bidPrice = oraclePrice.sub(bidSpread);

		// Ask Price = Oracle Price + Ask Spread
		const askPrice = oraclePrice.add(askSpread);

		return {
			bid: {
				price: bidPrice,
				size: bidSize,
				side: PositionSide.LONG,
				reduceOnly: false, // Default false, logic can be enhanced
				oracleOffset: bidSpread.neg(), // Bid is below oracle
			},
			ask: {
				price: askPrice,
				size: askSize,
				side: PositionSide.SHORT,
				reduceOnly: false, // Default false
				oracleOffset: askSpread, // Ask is above oracle
			},
		};
	}
}
