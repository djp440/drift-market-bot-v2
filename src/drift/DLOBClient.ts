
import WebSocket from 'ws';
import { EventEmitter } from 'events';
import { Logger } from '../logger/Logger.js';
import { BN, PRICE_PRECISION } from '@drift-labs/sdk';

interface L2Level {
    price: string;
    size: string;
    sources: {
        [key: string]: string;
    };
}

interface L2Update {
    type: 'l2';
    marketIndex: number;
    marketType: string;
    bids: L2Level[];
    asks: L2Level[];
    slot: number;
    ts: number;
}

export class DLOBClient extends EventEmitter {
    private ws: WebSocket | null = null;
    private logger: Logger;
    private marketIndex: number;
    private marketSymbol: string;
    private reconnectTimer: NodeJS.Timeout | null = null;
    private isConnected: boolean = false;
    private readonly WS_URL = "wss://dlob.drift.trade/ws";

    // 缓存最新的 L2 数据
    private bestBid: BN | null = null;
    private bestAsk: BN | null = null;

    constructor(logger: Logger, marketIndex: number, marketSymbol: string) {
        super();
        this.logger = logger;
        this.marketIndex = marketIndex;
        this.marketSymbol = marketSymbol;
    }

    public connect(): void {
        if (this.ws) {
            return;
        }

        this.logger.info("正在连接 DLOB WebSocket...", { url: this.WS_URL });
        this.ws = new WebSocket(this.WS_URL);

        this.ws.on('open', () => {
            this.logger.info("DLOB WebSocket 已连接");
            this.isConnected = true;
            this.subscribe();
        });

        this.ws.on('message', (data: WebSocket.Data) => {
            try {
                const message = JSON.parse(data.toString());
                if (message.channel === 'orderbook') {
                    this.handleL2Update(message.data);
                }
            } catch (error) {
                this.logger.error("解析 DLOB 消息失败", error);
            }
        });

        this.ws.on('error', (error) => {
            this.logger.error("DLOB WebSocket 错误", error);
        });

        this.ws.on('close', () => {
            this.logger.warn("DLOB WebSocket 已断开");
            this.isConnected = false;
            this.ws = null;
            this.scheduleReconnect();
        });
    }

    private subscribe(): void {
        if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;

        const subscribeMsg = {
            type: "subscribe",
            channel: "orderbook",
            marketType: "perp",
            market: this.marketSymbol, // e.g. "SOL-PERP"
            // grouping: 0 // No grouping for precision
        };

        this.logger.info("订阅 DLOB 订单簿", { market: this.marketSymbol });
        this.ws.send(JSON.stringify(subscribeMsg));
    }

    private handleL2Update(data: any): void {
        // data structure: 
        // { 
        //   marketIndex: number, 
        //   marketType: string, 
        //   bids: [{ price: "123", size: "100" }, ...], 
        //   asks: [{ price: "124", size: "100" }, ...] 
        // }
        // 注意：Drift DLOB 返回的 price 是缩放后的字符串 (PRICE_PRECISION)
        
        // 解析 Bids (买单)，通常是降序排列 (High -> Low)，Best Bid 是第一个
        if (data.bids && data.bids.length > 0) {
            // 安全起见，我们取第一个价格
            // 注意：某些情况下 DLOB 可能返回空数组或不规范数据
            const priceStr = data.bids[0].price;
            if (priceStr) {
                this.bestBid = new BN(priceStr);
            }
        }

        // 解析 Asks (卖单)，通常是升序排列 (Low -> High)，Best Ask 是第一个
        if (data.asks && data.asks.length > 0) {
            const priceStr = data.asks[0].price;
            if (priceStr) {
                this.bestAsk = new BN(priceStr);
            }
        }

        // 简单的验证：Best Ask 必须大于 Best Bid (除非出现倒挂，极少见)
        // 如果数据异常（例如倒挂严重），可能需要忽略或报警
        if (this.bestBid && this.bestAsk && this.bestBid.gt(this.bestAsk)) {
            this.logger.warn("DLOB 出现买卖倒挂 (Crossed Market)", {
                bid: this.bestBid.toString(),
                ask: this.bestAsk.toString()
            });
            // 这种情况下，Mid Price 计算仍然是 (Bid+Ask)/2，虽然倒挂但数学上 Mid 还在中间。
            // 但这暗示数据可能不稳定。
        }

        // this.logger.debug("DLOB L2 更新", { 
        //     bestBid: this.bestBid?.toString(), 
        //     bestAsk: this.bestAsk?.toString() 
        // });
    }

    private scheduleReconnect(): void {
        if (this.reconnectTimer) return;
        
        this.logger.info("5秒后尝试重连 DLOB...");
        this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            this.connect();
        }, 5000);
    }

    public getBestBidAsk(): { bestBid: BN; bestAsk: BN } | null {
        if (this.bestBid && this.bestAsk) {
            return {
                bestBid: this.bestBid,
                bestAsk: this.bestAsk
            };
        }
        return null;
    }

    public disconnect(): void {
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        if (this.ws) {
            this.ws.removeAllListeners();
            this.ws.close();
            this.ws = null;
        }
        this.isConnected = false;
    }
}
