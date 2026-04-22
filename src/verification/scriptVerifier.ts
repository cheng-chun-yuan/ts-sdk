import { Script } from "@scure/btc-signer";
import { tapLeafHash } from "@scure/btc-signer/payment.js";
import {
    compareBytes,
    hash160,
    sha256,
    tagSchnorr,
    taprootTweakPubkey,
} from "@scure/btc-signer/utils.js";
import { decodeTapscript, TapscriptType } from "../script/tapscript";
import { scriptFromTapLeafScript } from "../script/base";
import { ConditionWitness, getArkPsbtFields } from "../utils/unknownFields";
import { sequenceToTimelock } from "../contracts/handlers/helpers";
import type { Transaction } from "@scure/btc-signer/transaction.js";

function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

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

/**
 * Confirmation info of the parent transaction being spent.
 * Used by CSV to check whether enough blocks/seconds have actually
 * elapsed since the parent was confirmed, not just that nSequence
 * encodes the right value.
 */
export interface ParentConfirmation {
    blockHeight: number;
    blockTime: number;
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

/**
 * Walk the control block's merkle path starting from `leafHash` to recover
 * the taproot tree's merkle root. Each step hashes the lexicographically
 * smaller sibling first (BIP-341).
 */
function computeTapMerkleRoot(
    leafHash: Uint8Array,
    merklePath: Uint8Array[]
): Uint8Array {
    let current = leafHash;
    for (const sibling of merklePath) {
        const [a, b] =
            compareBytes(current, sibling) < 0
                ? [current, sibling]
                : [sibling, current];
        current = tagSchnorr("TapBranch", a, b);
    }
    return current;
}

/**
 * Verifies the taproot control block + tap leaf commit to the spent prevout.
 *
 * @param prevoutScript - Trusted scriptPubKey of the spent output. Required for
 * a sound check; if omitted, falls back to `input.witnessUtxo.script` which is
 * PSBT-controlled and lets a forged control block + matching forged witnessUtxo
 * pass. Internal callers (vtxoChainVerifier) source this from the fetched parent
 * commitment / path tx, so the comparison is anchored in trusted state.
 */
export function verifyTaprootScriptTree(
    tx: Transaction,
    inputIndex: number,
    prevoutScript?: Uint8Array
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

    if (!controlBlock?.internalKey) {
        errors.push("Missing internal key in tap leaf control block");
        return makeResult(tx, inputIndex, leafType, errors);
    }

    try {
        const rawScript = scriptFromTapLeafScript(leaf);
        // Mask parity bit: control-block version encodes leafVersion|parity,
        // but tapLeafHash takes the raw leaf version (bit 0 must be zero).
        const leafVersion = controlBlock.version & 0xfe;
        const computedLeafHash = tapLeafHash(rawScript, leafVersion);

        // Every tapScriptSig must reference the leaf we're verifying.
        // Checking only the first entry would let a mismatched signature
        // hide behind a correct one in multi-sig paths.
        if (input.tapScriptSig) {
            for (const entry of input.tapScriptSig) {
                const sigLeafHash = entry[0]?.leafHash;
                if (
                    sigLeafHash &&
                    compareBytes(computedLeafHash, sigLeafHash) !== 0
                ) {
                    errors.push(
                        "tapScriptSig leaf hash does not match computed leaf hash from tapLeafScript"
                    );
                    break;
                }
            }
        }

        const decoded = decodeTapscript(rawScript);
        leafType = decoded.type;

        // Reconstruct the taproot output key from internalKey + merkle path +
        // leaf hash, and compare against the trusted spent-output script.
        // Without this, a forged control block with an arbitrary leaf and
        // internal key would pass the structural checks above.
        const script = prevoutScript ?? input.witnessUtxo?.script;
        if (!script) {
            errors.push(
                "Missing prevout script — cannot verify control block against spent output"
            );
        } else if (
            script.length !== 34 ||
            script[0] !== 0x51 ||
            script[1] !== 0x20
        ) {
            errors.push(
                "witnessUtxo.script is not a P2TR output (OP_1 <32>); cannot verify control block"
            );
        } else {
            const expectedOutputKey = script.subarray(2, 34);
            const merkleRoot = computeTapMerkleRoot(
                computedLeafHash,
                controlBlock.merklePath ?? []
            );
            const [derivedKey, parity] = taprootTweakPubkey(
                controlBlock.internalKey,
                merkleRoot
            );
            if (compareBytes(derivedKey, expectedOutputKey) !== 0) {
                errors.push(
                    "Control block does not commit to the spent taproot output key"
                );
            }
            const expectedParity = controlBlock.version & 1;
            if (parity !== expectedParity) {
                errors.push(
                    `Control block parity bit ${expectedParity} does not match derived output key parity ${parity}`
                );
            }
        }
    } catch (err) {
        errors.push(
            `Failed to verify taproot script tree: ${errorMessage(err)}`
        );
    }

    return makeResult(tx, inputIndex, leafType, errors);
}

export function verifyCSV(
    tx: Transaction,
    inputIndex: number,
    chainTip: ChainTip,
    parentConfirmation?: ParentConfirmation
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

        // OP_CHECKSEQUENCEVERIFY is only enforced when the spending tx is
        // version >= 2. A PSBT with version 1 plus a matching nSequence
        // would fail consensus, so reject it here rather than marking
        // the chain spendable.
        if (tx.version < 2) {
            errors.push(`CSV requires tx version >= 2, got ${tx.version}`);
            return makeResult(tx, inputIndex, leafType, errors);
        }

        // Check nSequence against script requirement. BIP-68 disables the
        // relative locktime when bit 31 is set — not just 0xffffffff — so
        // values like 0x80000001 must also be rejected.
        const nSequence = input.sequence;
        const CSV_DISABLE_FLAG = 0x80000000;
        if (nSequence === undefined) {
            errors.push("nSequence is not set (CSV required)");
            return makeResult(tx, inputIndex, leafType, errors);
        }
        if ((nSequence & CSV_DISABLE_FLAG) !== 0) {
            errors.push(
                `nSequence ${nSequence.toString(16)} has the BIP-68 disable flag set`
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

            // Check elapsed time since parent confirmation (if provided)
            if (
                parentConfirmation &&
                seqTimelock.type === scriptTimelock.type
            ) {
                if (scriptTimelock.type === "blocks") {
                    const elapsed =
                        chainTip.height - parentConfirmation.blockHeight;
                    if (elapsed < Number(scriptTimelock.value)) {
                        errors.push(
                            `CSV not yet satisfiable: ${elapsed} blocks elapsed since parent confirmation, need ${scriptTimelock.value}`
                        );
                    }
                } else {
                    const elapsed =
                        chainTip.time - parentConfirmation.blockTime;
                    if (elapsed < Number(scriptTimelock.value)) {
                        errors.push(
                            `CSV not yet satisfiable: ${elapsed}s elapsed since parent confirmation, need ${scriptTimelock.value}s`
                        );
                    }
                }
            }
        } catch {
            errors.push(`Failed to decode nSequence ${nSequence} as BIP-68`);
        }
    } catch (err) {
        errors.push(`CSV verification failed: ${errorMessage(err)}`);
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
        errors.push(`CLTV verification failed: ${errorMessage(err)}`);
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

        // Enforce the exact supported condition pattern:
        //   [HASH_OP, <20- or 32-byte hash>, EQUAL | EQUALVERIFY]
        // Scanning for HASH_OP anywhere is not enough: a script like
        // `HASH160 <hash> EQUAL NOT` would let a matching preimage pass
        // this check even though it leaves `false` on the stack at
        // consensus time. Reject anything that isn't this exact shape.
        const condOps = Script.decode(conditionScript);
        if (condOps.length !== 3) {
            errors.push(
                `Unsupported condition script shape: expected 3 ops, got ${condOps.length}`
            );
            return makeResult(tx, inputIndex, leafType, errors);
        }
        const [hashOpRaw, expectedHashRaw, tailOpRaw] = condOps;
        const hashOp =
            hashOpRaw === "HASH160" || hashOpRaw === "SHA256"
                ? hashOpRaw
                : undefined;
        if (!hashOp) {
            errors.push(
                `Unsupported condition hash opcode: ${String(hashOpRaw)}`
            );
            return makeResult(tx, inputIndex, leafType, errors);
        }
        if (!(expectedHashRaw instanceof Uint8Array)) {
            errors.push("Condition script hash operand is not bytes");
            return makeResult(tx, inputIndex, leafType, errors);
        }
        const expectedHashLen = hashOp === "HASH160" ? 20 : 32;
        if (expectedHashRaw.length !== expectedHashLen) {
            errors.push(
                `Condition script hash is ${expectedHashRaw.length} bytes, expected ${expectedHashLen}`
            );
            return makeResult(tx, inputIndex, leafType, errors);
        }
        if (tailOpRaw !== "EQUAL" && tailOpRaw !== "EQUALVERIFY") {
            errors.push(
                `Condition script must end in EQUAL/EQUALVERIFY, got ${String(tailOpRaw)}`
            );
            return makeResult(tx, inputIndex, leafType, errors);
        }
        const expectedHash = expectedHashRaw;

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

        if (compareBytes(computedHash, expectedHash) !== 0) {
            errors.push(
                `Hash preimage mismatch: ${hashOp}(preimage) does not match expected hash`
            );
        }
    } catch (err) {
        errors.push(`Hash preimage verification failed: ${errorMessage(err)}`);
    }

    return makeResult(tx, inputIndex, leafType, errors);
}

export function verifyScriptSatisfaction(
    tx: Transaction,
    inputIndex: number,
    chainTip: ChainTip,
    parentConfirmation?: ParentConfirmation,
    prevoutScript?: Uint8Array
): ScriptVerificationResult {
    const input = tx.getInput(inputIndex);

    if (!input.tapLeafScript || input.tapLeafScript.length === 0) {
        return makeResult(tx, inputIndex, "unknown", [
            "Missing tapLeafScript for script satisfaction check",
        ]);
    }

    // Prerequisite: the tap leaf + control block must actually commit to
    // the spent P2TR output. Without this gate, CSV/CLTV/preimage checks
    // can succeed on a forged leaf the attacker slipped into the PSBT.
    const treeResult = verifyTaprootScriptTree(tx, inputIndex, prevoutScript);
    if (!treeResult.valid) {
        return treeResult;
    }

    let leafType: string;
    try {
        const rawScript = scriptFromTapLeafScript(input.tapLeafScript[0]);
        const decoded = decodeTapscript(rawScript);
        leafType = decoded.type;
    } catch (err) {
        return makeResult(tx, inputIndex, "unknown", [
            `Failed to decode tapscript: ${errorMessage(err)}`,
        ]);
    }

    switch (leafType) {
        case TapscriptType.Multisig:
            // Signatures covered by Tier 1 verifyTreeSignatures
            return makeResult(tx, inputIndex, leafType, []);

        case TapscriptType.CSVMultisig:
            return verifyCSV(tx, inputIndex, chainTip, parentConfirmation);

        case TapscriptType.CLTVMultisig:
            return verifyCLTV(tx, inputIndex, chainTip);

        case TapscriptType.ConditionMultisig:
            return verifyHashPreimage(tx, inputIndex);

        case TapscriptType.ConditionCSVMultisig: {
            // Check both CSV and hash preimage
            const csvResult = verifyCSV(
                tx,
                inputIndex,
                chainTip,
                parentConfirmation
            );
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
