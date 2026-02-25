
import { 
    DriftClient, 
    DLOBSubscriber, 
    MarketType,
    Wallet,
    loadKeypair
} from "@drift-labs/sdk";
import { Connection, Keypair } from "@solana/web3.js";

async function main() {
    console.log("Checking DLOBSubscriber exports...");
    console.log("DLOBSubscriber available:", !!DLOBSubscriber);
}

main().catch(console.error);
