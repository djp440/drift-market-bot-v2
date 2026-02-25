import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import {
  DriftClient,
  UserAccount,
  PerpPosition,
  PRICE_PRECISION,
  QUOTE_PRECISION,
  BN,
  IWallet,
  OraclePriceData,
} from "@drift-labs/sdk";
import { Logger } from "../logger/Logger.js";
import type { DriftEnv } from "../env.js";

export { PRICE_PRECISION, QUOTE_PRECISION };
export type { BN };

export interface Position {
  marketIndex: number;
  size: BN;
  side: "long" | "short" | "none";
  entryPrice: BN;
  unrealizedPnl: BN;
}

export class DriftClientWrapper {
  private connection: Connection;
  private driftClient: DriftClient;
  private logger: Logger;
  private userAccountCallback: ((account: UserAccount) => void) | null = null;

  constructor(
    privateKey: Uint8Array,
    rpcUrl: string,
    driftEnv: DriftEnv,
    logger: Logger
  ) {
    this.logger = logger;

    this.connection = new Connection(rpcUrl, {
      commitment: "confirmed",
      wsEndpoint: undefined,
    });

    const keypair = Keypair.fromSecretKey(privateKey);
    const wallet: IWallet = {
      publicKey: keypair.publicKey,
      payer: keypair,
      signTransaction: async (transaction: Transaction): Promise<Transaction> => {
        transaction.partialSign(keypair);
        return transaction;
      },
      signAllTransactions: async (transactions: Transaction[]): Promise<Transaction[]> => {
        return transactions.map((transaction) => {
          transaction.partialSign(keypair);
          return transaction;
        });
      },
    };

    this.driftClient = new DriftClient({
      connection: this.connection,
      wallet: wallet,
      env: driftEnv,
    });
  }

  async initialize(): Promise<void> {
    this.logger.info("正在初始化 DriftClient", {});

    await this.driftClient.subscribe();

    this.logger.info("DriftClient 初始化完成", {});
  }

  async getOraclePrice(marketIndex: number): Promise<BN> {
    const oraclePriceData = this.driftClient.getOracleDataForPerpMarket(marketIndex);
    return oraclePriceData.price;
  }

  getOraclePriceData(marketIndex: number): OraclePriceData {
    return this.driftClient.getOracleDataForPerpMarket(marketIndex);
  }

  getOraclePublicKey(marketIndex: number): PublicKey {
    const market = this.driftClient.getPerpMarketAccount(marketIndex);
    if (!market) {
      throw new Error(`Market ${marketIndex} not found`);
    }
    return market.amm.oracle;
  }

  async getPosition(marketIndex: number): Promise<Position> {
    try {
      const userAccount = this.driftClient.getUserAccount();
      if (!userAccount) {
        return this.createEmptyPosition(marketIndex);
      }

      const position = userAccount.perpPositions.find(
        (p: PerpPosition) => p.marketIndex === marketIndex
      );

      if (!position || position.baseAssetAmount.eq(new BN(0))) {
        return this.createEmptyPosition(marketIndex);
      }

      const side = position.baseAssetAmount.gt(new BN(0)) ? "long" : "short";
      const size = position.baseAssetAmount.abs();

      let entryPrice = new BN(0);
      if (!size.eq(new BN(0))) {
        entryPrice = position.quoteEntryAmount.abs().mul(PRICE_PRECISION).div(size);
      }

      return {
        marketIndex,
        size,
        side,
        entryPrice,
        unrealizedPnl: new BN(0),
      };
    } catch (error) {
      return this.createEmptyPosition(marketIndex);
    }
  }

  private createEmptyPosition(marketIndex: number): Position {
    return {
      marketIndex,
      size: new BN(0),
      side: "none",
      entryPrice: new BN(0),
      unrealizedPnl: new BN(0),
    };
  }

  getAccountInfo(): UserAccount | null {
    try {
      return this.driftClient.getUserAccount() ?? null;
    } catch (error) {
      return null;
    }
  }

  getDriftClient(): DriftClient {
    return this.driftClient;
  }

  getConnection(): Connection {
    return this.connection;
  }

  async subscribe(callback: (account: UserAccount) => void): Promise<void> {
    this.userAccountCallback = callback;

    try {
      const userAccount = this.driftClient.getUserAccount();
      if (userAccount) {
        callback(userAccount);
      }
    } catch (error) {
      this.logger.warn("当前钱包尚未在 Drift 上初始化账户，将等待账户创建", {
        error: (error as Error).message,
      });
    }

    this.driftClient.eventEmitter.on("userAccountUpdate", (account: UserAccount) => {
      if (this.userAccountCallback) {
        this.userAccountCallback(account);
      }
    });

    this.logger.info("已订阅用户账户变更事件", {});
  }

  async unsubscribe(): Promise<void> {
    await this.driftClient.unsubscribe();
    this.logger.info("DriftClient 已取消订阅", {});
  }
}
