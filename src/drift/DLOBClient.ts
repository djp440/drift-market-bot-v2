
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
        // data structure: { marketIndex, bids: [], asks: [], ... }
        // 注意：Drift DLOB 返回的 price 是缩放后的字符串 (PRICE_PRECISION)
        
        if (data.bids && data.bids.length > 0) {
            // bids are sorted desc (best bid is first)
            this.bestBid = new BN(data.bids[0].price);
        }

        if (data.asks && data.asks.length > 0) {
            // asks are sorted asc (best ask is first)
            this.bestAsk = new BN(data.asks[0].price);
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
