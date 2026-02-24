import dotenv from "dotenv";
import bs58 from "bs58";

type DriftEnv = "mainnet-beta" | "devnet";

type Env = {
  solanaRpcUrl: string;
  driftEnv: DriftEnv;
  privateKey: Uint8Array;
};

export const loadEnv = (): Env => {
  dotenv.config();

  const solanaRpcUrl = process.env.SOLANA_RPC_URL;
  const driftEnv = process.env.DRIFT_ENV as DriftEnv;
  const privateKeyString = process.env.PRIVATE_KEY;

  if (!solanaRpcUrl) {
    throw new Error("缺少环境变量 SOLANA_RPC_URL");
  }

  if (!driftEnv || !["mainnet-beta", "devnet"].includes(driftEnv)) {
    throw new Error("缺少环境变量 DRIFT_ENV，必须为 'mainnet-beta' 或 'devnet'");
  }

  if (!privateKeyString) {
    throw new Error("缺少环境变量 PRIVATE_KEY");
  }

  let privateKey: Uint8Array;
  try {
    if (privateKeyString.startsWith("[") && privateKeyString.endsWith("]")) {
      // 尝试解析 JSON 数组格式
      privateKey = new Uint8Array(JSON.parse(privateKeyString));
    } else {
      // 尝试解析 Base58 格式
      privateKey = bs58.decode(privateKeyString);
    }
  } catch (error) {
    throw new Error("PRIVATE_KEY 格式错误，支持 JSON 数组 [1,2,3...] 或 Base58 字符串");
  }

  if (privateKey.length !== 64) {
    throw new Error("无效的私钥长度，Solana 私钥应为 64 字节");
  }

  return {
    solanaRpcUrl,
    driftEnv,
    privateKey,
  };
};

export type { Env, DriftEnv };
