
import { 
    DLOBNodeClient
} from "@drift-labs/sdk";

async function main() {
    console.log("Checking DLOBNodeClient exports...");
    console.log("DLOBNodeClient available:", !!DLOBNodeClient);
}

main().catch(console.error);
