
import * as sdk from "@drift-labs/sdk";

async function main() {
    console.log("SDK Exports:", Object.keys(sdk).filter(k => k.includes("DLOB")));
}

main().catch(console.error);
