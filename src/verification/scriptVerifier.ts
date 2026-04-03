import { hex } from "@scure/base";
import { Script } from "@scure/btc-signer";
import { tapLeafHash } from "@scure/btc-signer/payment.js";
import { hash160, sha256 } from "@scure/btc-signer/utils.js";
import { decodeTapscript, TapscriptType } from "../script/tapscript";
import { scriptFromTapLeafScript } from "../script/base";
import { ConditionWitness, getArkPsbtFields } from "../utils/unknownFields";
import { sequenceToTimelock } from "../contracts/handlers/helpers";
import type { Transaction } from "@scure/btc-signer/transaction.js";

export interface ScriptVerificationResult {
    txid: string;
    inputIndex: number;
    leafType: string;
    valid: boolean;
    errors: string[];
}

export interface ChainTip {
    height: number;
    time: number;
}

const LOCKTIME_THRESHOLD = 500_000_000;

function makeResult(
    tx: Transaction,
    inputIndex: number,
    leafType: string,
    errors: string[]
): ScriptVerificationResult {
    return {
        txid: tx.id,
        inputIndex,
        leafType,
        valid: errors.length === 0,
        errors,
    };
}

export function verifyTaprootScriptTree(
    tx: Transaction,
    inputIndex: number
): ScriptVerificationResult {
    const errors: string[] = [];
    let leafType = "unknown";

    const input = tx.getInput(inputIndex);
    if (!input.tapLeafScript || input.tapLeafScript.length === 0) {
        errors.push("Missing tapLeafScript on input");
        return makeResult(tx, inputIndex, leafType, errors);
    }

    const leaf = input.tapLeafScript[0];
    const controlBlock = leaf[0];
    const scriptWithVersion = leaf[1];

    if (!controlBlock?.internalKey) {
        errors.push("Missing internal key in tap leaf control block");
        return makeResult(tx, inputIndex, leafType, errors);
    }

    // Verify leaf hash can be computed from script
    try {
        const rawScript = scriptFromTapLeafScript(leaf);
        tapLeafHash(rawScript);

        const decoded = decodeTapscript(rawScript);
        leafType = decoded.type;
    } catch (err) {
        errors.push(
            `Failed to decode tapscript: ${err instanceof Error ? err.message : String(err)}`
        );
    }

    return makeResult(tx, inputIndex, leafType, errors);
}

export function verifyCSV(
    tx: Transaction,
    inputIndex: number,
    _chainTip: ChainTip
): ScriptVerificationResult {
    const errors: string[] = [];
    const input = tx.getInput(inputIndex);

    if (!input.tapLeafScript || input.tapLeafScript.length === 0) {
        errors.push("Missing tapLeafScript for CSV verification");
        return makeResult(tx, inputIndex, "unknown", errors);
    }

    let leafType = "unknown";
    try {
        const rawScript = scriptFromTapLeafScript(input.tapLeafScript[0]);
        const decoded = decodeTapscript(rawScript);
        leafType = decoded.type;

        if (
            decoded.type !== TapscriptType.CSVMultisig &&
            decoded.type !== TapscriptType.ConditionCSVMultisig
        ) {
            errors.push(`Script is ${decoded.type}, not a CSV tapscript`);
            return makeResult(tx, inputIndex, leafType, errors);
        }

        const scriptTimelock = decoded.params.timelock;
        if (!scriptTimelock) {
            errors.push("CSV script has no timelock parameter");
            return makeResult(tx, inputIndex, leafType, errors);
        }

        // Check nSequence against script requirement
        const nSequence = input.sequence;
        if (nSequence === undefined || nSequence === 0xffffffff) {
            errors.push(
                "nSequence is not set or disables relative locktime (CSV)"
            );
            return makeResult(tx, inputIndex, leafType, errors);
        }

        try {
            const seqTimelock = sequenceToTimelock(nSequence);

            // Check type consistency
            if (seqTimelock.type !== scriptTimelock.type) {
                errors.push(
                    `CSV type inconsistent: nSequence encodes ${seqTimelock.type}, script requires ${scriptTimelock.type}`
                );
            }

            // Check value meets requirement
            if (
                seqTimelock.type === scriptTimelock.type &&
                seqTimelock.value < scriptTimelock.value
            ) {
                errors.push(
                    `nSequence value ${seqTimelock.value} is below CSV requirement ${scriptTimelock.value}`
                );
            }
        } catch {
            errors.push(`Failed to decode nSequence ${nSequence} as BIP-68`);
        }
    } catch (err) {
        errors.push(
            `CSV verification failed: ${err instanceof Error ? err.message : String(err)}`
        );
    }

    return makeResult(tx, inputIndex, leafType, errors);
}

export function verifyCLTV(
    tx: Transaction,
    inputIndex: number,
    chainTip: ChainTip
): ScriptVerificationResult {
    const errors: string[] = [];
    const input = tx.getInput(inputIndex);

    if (!input.tapLeafScript || input.tapLeafScript.length === 0) {
        errors.push("Missing tapLeafScript for CLTV verification");
        return makeResult(tx, inputIndex, "unknown", errors);
    }

    let leafType = "unknown";
    try {
        const rawScript = scriptFromTapLeafScript(input.tapLeafScript[0]);
        const decoded = decodeTapscript(rawScript);
        leafType = decoded.type;

        if (decoded.type !== TapscriptType.CLTVMultisig) {
            errors.push(`Script is ${decoded.type}, not a CLTV tapscript`);
            return makeResult(tx, inputIndex, leafType, errors);
        }

        const scriptLocktime = decoded.params.absoluteTimelock;
        if (scriptLocktime === undefined) {
            errors.push("CLTV script has no absoluteTimelock parameter");
            return makeResult(tx, inputIndex, leafType, errors);
        }

        // Check nSequence doesn't disable locktime
        const nSequence = input.sequence;
        if (nSequence === 0xffffffff) {
            errors.push(
                "nSequence is 0xFFFFFFFF which disables locktime (CLTV)"
            );
            return makeResult(tx, inputIndex, leafType, errors);
        }

        // Check nLockTime meets script value
        const nLockTime = BigInt(tx.lockTime ?? 0);
        if (nLockTime < scriptLocktime) {
            errors.push(
                `nLockTime ${nLockTime} is below CLTV requirement ${scriptLocktime}`
            );
        }

        // Check domain consistency (blocks <500M vs seconds >=500M)
        const scriptIsTime = scriptLocktime >= BigInt(LOCKTIME_THRESHOLD);
        const txIsTime = nLockTime >= BigInt(LOCKTIME_THRESHOLD);
        if (scriptIsTime !== txIsTime) {
            errors.push(
                `CLTV domain mismatch: script uses ${scriptIsTime ? "seconds" : "blocks"}, nLockTime uses ${txIsTime ? "seconds" : "blocks"}`
            );
        }

        // Verify chain tip satisfies the locktime
        if (scriptIsTime) {
            if (chainTip.time < Number(scriptLocktime)) {
                errors.push(
                    `Chain tip time ${chainTip.time} has not reached CLTV time ${scriptLocktime}`
                );
            }
        } else {
            if (chainTip.height < Number(scriptLocktime)) {
                errors.push(
                    `Chain tip height ${chainTip.height} has not reached CLTV height ${scriptLocktime}`
                );
            }
        }
    } catch (err) {
        errors.push(
            `CLTV verification failed: ${err instanceof Error ? err.message : String(err)}`
        );
    }

    return makeResult(tx, inputIndex, leafType, errors);
}

export function verifyHashPreimage(
    tx: Transaction,
    inputIndex: number
): ScriptVerificationResult {
    const errors: string[] = [];
    const input = tx.getInput(inputIndex);

    if (!input.tapLeafScript || input.tapLeafScript.length === 0) {
        errors.push("Missing tapLeafScript for hash preimage verification");
        return makeResult(tx, inputIndex, "unknown", errors);
    }

    let leafType = "unknown";
    try {
        const rawScript = scriptFromTapLeafScript(input.tapLeafScript[0]);
        const decoded = decodeTapscript(rawScript);
        leafType = decoded.type;

        const conditionScript = decoded.params.conditionScript;
        if (!conditionScript) {
            errors.push("Script has no conditionScript for hash verification");
            return makeResult(tx, inputIndex, leafType, errors);
        }

        // Parse the condition script opcodes to detect hash algorithm
        const condOps = Script.decode(conditionScript);

        // Get condition witness (preimage) from PSBT fields
        const witnesses = getArkPsbtFields(tx, inputIndex, ConditionWitness);
        if (
            witnesses.length === 0 ||
            !witnesses[0] ||
            witnesses[0].length === 0
        ) {
            errors.push("Missing condition witness (preimage) in PSBT fields");
            return makeResult(tx, inputIndex, leafType, errors);
        }

        const preimage = witnesses[0][0];

        // Detect hash op and expected hash from condition script
        // Format: [HASH_OP, <expected_hash>, EQUAL] or [HASH_OP, <expected_hash>, EQUALVERIFY]
        let hashOp: string | undefined;
        let expectedHash: Uint8Array | undefined;

        for (let i = 0; i < condOps.length; i++) {
            const op = condOps[i];
            if (op === "HASH160" || op === "SHA256" || op === "HASH256") {
                hashOp = op as string;
                const next = condOps[i + 1];
                if (next instanceof Uint8Array) {
                    expectedHash = next;
                }
                break;
            }
        }

        if (!hashOp || !expectedHash) {
            errors.push("Could not detect hash operation in condition script");
            return makeResult(tx, inputIndex, leafType, errors);
        }

        // Compute hash and compare
        let computedHash: Uint8Array;
        if (hashOp === "HASH160") {
            computedHash = hash160(preimage);
        } else if (hashOp === "SHA256") {
            computedHash = sha256(preimage);
        } else {
            errors.push(`Unsupported hash operation: ${hashOp}`);
            return makeResult(tx, inputIndex, leafType, errors);
        }

        if (hex.encode(computedHash) !== hex.encode(expectedHash)) {
            errors.push(
                `Hash preimage mismatch: ${hashOp}(preimage) does not match expected hash`
            );
        }
    } catch (err) {
        errors.push(
            `Hash preimage verification failed: ${err instanceof Error ? err.message : String(err)}`
        );
    }

    return makeResult(tx, inputIndex, leafType, errors);
}

export function verifyScriptSatisfaction(
    tx: Transaction,
    inputIndex: number,
    chainTip: ChainTip
): ScriptVerificationResult {
    const input = tx.getInput(inputIndex);

    if (!input.tapLeafScript || input.tapLeafScript.length === 0) {
        return makeResult(tx, inputIndex, "unknown", [
            "Missing tapLeafScript for script satisfaction check",
        ]);
    }

    let leafType: string;
    try {
        const rawScript = scriptFromTapLeafScript(input.tapLeafScript[0]);
        const decoded = decodeTapscript(rawScript);
        leafType = decoded.type;
    } catch (err) {
        return makeResult(tx, inputIndex, "unknown", [
            `Failed to decode tapscript: ${err instanceof Error ? err.message : String(err)}`,
        ]);
    }

    switch (leafType) {
        case TapscriptType.Multisig:
            // Signatures covered by Tier 1 verifyTreeSignatures
            return makeResult(tx, inputIndex, leafType, []);

        case TapscriptType.CSVMultisig:
            return verifyCSV(tx, inputIndex, chainTip);

        case TapscriptType.CLTVMultisig:
            return verifyCLTV(tx, inputIndex, chainTip);

        case TapscriptType.ConditionMultisig:
            return verifyHashPreimage(tx, inputIndex);

        case TapscriptType.ConditionCSVMultisig: {
            // Check both CSV and hash preimage
            const csvResult = verifyCSV(tx, inputIndex, chainTip);
            const hashResult = verifyHashPreimage(tx, inputIndex);
            const allErrors = [...csvResult.errors, ...hashResult.errors];
            return makeResult(tx, inputIndex, leafType, allErrors);
        }

        default:
            return makeResult(tx, inputIndex, leafType, [
                `Unknown tapscript type: ${leafType}`,
            ]);
    }
}
