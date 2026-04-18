import { base64 } from "@scure/base";
import { Transaction } from "../utils/transaction";

/**
 * Thrown when a stored virtual tx PSBT's computed txid does not match
 * the key it was stored under. Always indicates tampered state or a
 * logic bug upstream — never a benign parse failure.
 */
export class VirtualTxIntegrityError extends Error {
    readonly expectedTxid: string;
    readonly computedTxid: string;

    constructor(expectedTxid: string, computedTxid: string) {
        super(
            `Virtual tx integrity check failed: expected txid ${expectedTxid}, computed ${computedTxid}`
        );
        this.name = "VirtualTxIntegrityError";
        this.expectedTxid = expectedTxid;
        this.computedTxid = computedTxid;
    }
}

/**
 * Parse a base64-encoded virtual tx PSBT and assert its computed txid
 * matches the key it was stored under (`ExitData.virtualTxs[txid]`).
 *
 * Without this check, a tampered or swapped PSBT would be silently
 * persisted or broadcast — the keys come from the indexer or local
 * storage and are not authenticated by themselves.
 *
 * @throws {VirtualTxIntegrityError} when the computed txid does not match.
 * @throws other errors propagate as-is from the underlying PSBT parser.
 */
export function parseVirtualTx(
    expectedTxid: string,
    psbtBase64: string
): Transaction {
    const tx = Transaction.fromPSBT(base64.decode(psbtBase64));
    if (tx.id !== expectedTxid) {
        throw new VirtualTxIntegrityError(expectedTxid, tx.id);
    }
    return tx;
}
