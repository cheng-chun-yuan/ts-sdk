import { hex } from "@scure/base";
import { Transaction } from "@scure/btc-signer";
import { compareBytes } from "@scure/btc-signer/utils.js";
import type { OnchainProvider } from "../providers/onchain";

function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

export interface AnchorVerification {
    commitmentTxid: string;
    confirmed: boolean;
    blockHeight?: number;
    blockTime?: number;
    confirmationDepth: number;
    outputMatches: boolean;
    doubleSpent: boolean;
    errors: string[];
    warnings: string[];
}

export async function verifyOnchainAnchor(
    commitmentTxid: string,
    expectedOutputIndex: number,
    expectedAmount: bigint,
    expectedScript: Uint8Array,
    onchain: OnchainProvider,
    minDepth: number = 6,
    expectedSpenderTxid?: string,
    chainTip?: { height: number; time: number; hash: string }
): Promise<AnchorVerification> {
    const errors: string[] = [];
    const warnings: string[] = [];

    let confirmed = false;
    let blockHeight: number | undefined;
    let blockTime: number | undefined;
    let confirmationDepth = 0;

    try {
        const txStatus = await onchain.getTxStatus(commitmentTxid);
        if (txStatus.confirmed) {
            confirmed = true;
            blockHeight = txStatus.blockHeight;
            blockTime = txStatus.blockTime;

            const tip = chainTip ?? (await onchain.getChainTip());
            confirmationDepth = tip.height - txStatus.blockHeight + 1;

            if (confirmationDepth < minDepth) {
                warnings.push(
                    `Low confirmation depth: ${confirmationDepth} (minimum: ${minDepth})`
                );
            }
        } else {
            errors.push("Commitment transaction is not confirmed");
        }
    } catch (err) {
        errors.push(`Failed to get commitment tx status: ${errorMessage(err)}`);
        return {
            commitmentTxid,
            confirmed: false,
            confirmationDepth: 0,
            outputMatches: false,
            doubleSpent: false,
            errors,
            warnings,
        };
    }

    let outputMatches = false;
    try {
        const txHex = await onchain.getTxHex(commitmentTxid);
        const tx = Transaction.fromRaw(hex.decode(txHex));

        if (tx.outputsLength <= expectedOutputIndex) {
            errors.push(
                `Commitment tx has ${tx.outputsLength} outputs, expected at least ${expectedOutputIndex + 1}`
            );
        } else {
            const output = tx.getOutput(expectedOutputIndex);
            if (output?.amount === undefined || !output?.script) {
                errors.push(
                    `Commitment tx output ${expectedOutputIndex} is missing amount or script`
                );
            } else {
                const amountMatch = output.amount === expectedAmount;
                const scriptMatch =
                    compareBytes(output.script, expectedScript) === 0;

                if (!amountMatch) {
                    errors.push(
                        `Output amount mismatch: expected ${expectedAmount}, got ${output.amount}`
                    );
                }
                if (!scriptMatch) {
                    errors.push(
                        `Output script mismatch at index ${expectedOutputIndex}`
                    );
                }

                outputMatches = amountMatch && scriptMatch;
            }
        }
    } catch (err) {
        errors.push(`Failed to fetch commitment tx hex: ${errorMessage(err)}`);
    }

    // Check if the batch output has been spent and by whom.
    // If expectedSpenderTxid is provided, verify the spender matches;
    // a mismatch means the commitment output was double-spent by an
    // adversarial or unexpected transaction.
    let doubleSpent = false;
    try {
        const outspends = await onchain.getTxOutspends(commitmentTxid);
        if (
            outspends.length > expectedOutputIndex &&
            outspends[expectedOutputIndex].spent
        ) {
            const actualSpender = outspends[expectedOutputIndex].txid;
            if (expectedSpenderTxid) {
                if (actualSpender !== expectedSpenderTxid) {
                    doubleSpent = true;
                    errors.push(
                        `Commitment output ${expectedOutputIndex} spent by unexpected tx ${actualSpender}, expected ${expectedSpenderTxid}`
                    );
                }
                // If matches, the spend is expected — no warning needed
            } else {
                doubleSpent = true;
                warnings.push(
                    `Commitment tx output ${expectedOutputIndex} has been spent by ${actualSpender}`
                );
            }
        }
    } catch (err) {
        warnings.push(
            `Failed to check double-spend status: ${errorMessage(err)}`
        );
    }

    return {
        commitmentTxid,
        confirmed,
        blockHeight,
        blockTime,
        confirmationDepth,
        outputMatches,
        doubleSpent,
        errors,
        warnings,
    };
}
