import { hex } from "@scure/base";
import { Address, SigHash } from "@scure/btc-signer";
import { compareBytes } from "@scure/btc-signer/utils.js";
import type { Outpoint } from "../wallet";
import type { OnchainProvider } from "../providers/onchain";
import { ChainTxType } from "../providers/indexer";
import type { ExitClaimInput, ExitDataRepository } from "./exitDataStore";
import { validateExitData } from "./exitDataStore";
import { parseVirtualTx, VirtualTxIntegrityError } from "./virtualTx";
import { Transaction } from "../utils/transaction";
import type { Identity } from "../identity";
import type { Network } from "../networks";
import { VtxoScript } from "../script/base";
import {
    CSVMultisigTapscript,
    ConditionCSVMultisigTapscript,
    TapscriptType,
} from "../script/tapscript";
import { setArkPsbtField } from "../utils/unknownFields";
import { ConditionWitness } from "../utils/unknownFields";

function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

function isAlreadyBroadcastError(err: unknown): boolean {
    // Match only known-harmless "already accepted" rejections. A broader
    // match on "mempool" alone would silently swallow real failures like
    // "mempool-min-fee" or "mempool-conflict" and let sovereignExit report
    // success for a transaction that was never accepted. Normalize dashes
    // to spaces so "txn-already-in-mempool" matches the same pattern as
    // "already in mempool".
    const msg = errorMessage(err).toLowerCase().replace(/-/g, " ");
    return (
        msg.includes("already known") ||
        msg.includes("already in mempool") ||
        msg.includes("already in block chain")
    );
}

export interface SovereignExitOptions {
    identity?: Identity;
    outputAddress?: string;
    network?: Network;
    // Witness-stack elements that satisfy the hash condition on a
    // ConditionCSVMultisig exit leaf (e.g. a VHTLC unilateral claim).
    // Typically a single 32-byte preimage. Omit for plain CSV-multisig
    // exits; supply when the caller can sign a condition leaf.
    preimage?: Uint8Array[];
}

export interface SovereignExitStep {
    type: "broadcast" | "wait" | "done";
    txid: string;
    description: string;
}

export interface SovereignExitResult {
    success: boolean;
    steps: SovereignExitStep[];
    finalTxid?: string;
    errors: string[];
}

export async function canSovereignExit(
    vtxoOutpoint: Outpoint,
    exitDataRepo: ExitDataRepository,
    onchain: OnchainProvider,
    // Pass the identity that will actually sign the final claim so a
    // VHTLC-style script doesn't report canExit=true for a leaf the
    // caller can't sign (see buildFinalClaimTransaction).
    identity?: Identity,
    // If the elapsed leaf is a ConditionCSVMultisig (e.g. a VHTLC
    // unilateralClaim) the witness needs a hash preimage; without one
    // sovereignExit cannot finalize, so the leaf is skipped here too.
    preimage?: Uint8Array[]
): Promise<{
    canExit: boolean;
    reason?: string;
    exitPath?: string;
    timelockRemaining?: number;
}> {
    const data = await exitDataRepo.getExitData(vtxoOutpoint);
    if (!data) {
        return { canExit: false, reason: "No exit data stored for this VTXO" };
    }

    const validation = validateExitData(data);
    if (!validation.valid) {
        return {
            canExit: false,
            reason: `Invalid exit data: ${validation.errors.join(", ")}`,
        };
    }

    // Check every commitment anchored by this chain, not just the first.
    // A multi-batch VTXO can have several commitments; one unconfirmed
    // root is enough to make the exit unperformable.
    const commitmentTxids = data.chain
        .filter((c) => c.type === ChainTxType.COMMITMENT)
        .map((c) => c.txid);
    for (const commitTxid of commitmentTxids) {
        let status;
        try {
            status = await onchain.getTxStatus(commitTxid);
        } catch (err) {
            return {
                canExit: false,
                reason: `Failed to check commitment tx ${commitTxid}: ${errorMessage(err)}`,
            };
        }
        if (!status.confirmed) {
            return {
                canExit: false,
                reason: `Commitment tx ${commitTxid} is not confirmed onchain`,
            };
        }
    }

    // Without claimInput we can only broadcast the virtual tx chain, which
    // only needs the commitment confirmed. No exit-leaf timelock to check.
    if (!data.claimInput) {
        return { canExit: true };
    }

    // With a claimInput, the final-claim answer depends on which leaf the
    // caller can actually sign. Refuse to claim canExit=true without an
    // identity: otherwise a multi-leaf script (VHTLC-style) could return
    // canExit=true for a leaf the caller cannot satisfy, and the mismatch
    // only surfaces inside sovereignExit as a silent wait step.
    if (!identity) {
        return {
            canExit: false,
            reason: "Identity is required to evaluate claim-path exit leaves",
        };
    }

    let claimStatus;
    try {
        claimStatus = await onchain.getTxStatus(data.claimInput.txid);
    } catch (err) {
        return {
            canExit: false,
            reason: `Failed to check claim tx: ${errorMessage(err)}`,
        };
    }
    if (!claimStatus.confirmed) {
        return {
            canExit: false,
            reason: "Claim input tx is not yet confirmed; chain must be broadcast and confirmed first",
        };
    }

    const vtxoScript = VtxoScript.decode(hex.decode(data.claimInput.tapTree));
    const chainTip = await onchain.getChainTip();
    const signerPubkey = await identity.xOnlyPublicKey();
    const hasPreimage = Boolean(preimage && preimage.length > 0);
    const exit = availableExitPath(
        { height: claimStatus.blockHeight, time: claimStatus.blockTime },
        { height: chainTip.height, time: chainTip.time },
        vtxoScript,
        signerPubkey,
        hasPreimage
    );

    if (exit) {
        return { canExit: true, exitPath: exit.type, timelockRemaining: 0 };
    }

    const remaining = shortestExitWait(
        { height: claimStatus.blockHeight, time: claimStatus.blockTime },
        { height: chainTip.height, time: chainTip.time },
        vtxoScript,
        signerPubkey,
        hasPreimage
    );
    return {
        canExit: false,
        reason: "Exit timelock has not elapsed",
        timelockRemaining: remaining,
    };
}

/**
 * Returns the smallest remaining wait (blocks or seconds, caller's
 * responsibility to distinguish) across all exit paths, or Infinity if
 * the VTXO has no exit paths. Used to tell the caller how long until
 * canSovereignExit would return true.
 */
function shortestExitWait(
    confirmedAt: { height: number; time: number },
    current: { height: number; time: number },
    vtxoScript: VtxoScript,
    signerPubkey?: Uint8Array,
    hasPreimage?: boolean
): number {
    let min = Infinity;
    for (const exit of vtxoScript.exitPaths()) {
        if (
            signerPubkey &&
            !exit.params.pubkeys.some(
                (pk) => compareBytes(pk, signerPubkey) === 0
            )
        ) {
            continue;
        }
        if (exit.type === TapscriptType.ConditionCSVMultisig && !hasPreimage) {
            continue;
        }
        const wait =
            exit.params.timelock.type === "blocks"
                ? confirmedAt.height +
                  Number(exit.params.timelock.value) -
                  current.height
                : confirmedAt.time +
                  Number(exit.params.timelock.value) -
                  current.time;
        if (wait < min) min = wait;
    }
    return min;
}

export async function sovereignExit(
    vtxoOutpoint: Outpoint,
    exitDataRepo: ExitDataRepository,
    onchain: OnchainProvider,
    options?: SovereignExitOptions
): Promise<SovereignExitResult> {
    const steps: SovereignExitStep[] = [];
    const errors: string[] = [];

    const data = await exitDataRepo.getExitData(vtxoOutpoint);
    if (!data) {
        return {
            success: false,
            steps,
            errors: ["No exit data stored for this VTXO"],
        };
    }

    const validation = validateExitData(data);
    if (!validation.valid) {
        return {
            success: false,
            steps,
            errors: validation.errors,
        };
    }

    // Walk chain from root (commitment) toward leaf, broadcasting each tx.
    // We topologically sort the virtual txs by their actual PSBT inputs
    // rather than trusting data.chain's order: the indexer contract on
    // chain ordering is not documented, and a stored-cache corruption
    // would otherwise silently broadcast in the wrong order.
    // Broadcast only TREE / ARK virtual txs. Checkpoints have no PSBT
    // to broadcast and live only as DAG-integration pointers.
    const broadcastOrder = topoSortChainTxIds(
        data.chain
            .filter(
                (c) => c.type === ChainTxType.TREE || c.type === ChainTxType.ARK
            )
            .map((c) => c.txid),
        data.virtualTxs
    );
    if (broadcastOrder.error) {
        return {
            success: false,
            steps,
            errors: [`Broadcast order error: ${broadcastOrder.error}`],
        };
    }

    for (const txid of broadcastOrder.order) {
        try {
            const txStatus = await onchain.getTxStatus(txid);
            if (txStatus.confirmed) {
                steps.push({
                    type: "wait",
                    txid,
                    description: `Already confirmed: ${txid}`,
                });
                continue;
            }
        } catch {
            // Not found onchain — needs broadcasting
        }

        const psbt = data.virtualTxs[txid];
        if (!psbt) {
            errors.push(`Missing PSBT for tx ${txid}`);
            return { success: false, steps, errors };
        }

        // Finalize the PSBT and broadcast
        try {
            const tx = parseVirtualTx(txid, psbt);
            let sawTapKeySig = false;
            let sawTapScriptSig = false;

            for (
                let inputIndex = 0;
                inputIndex < tx.inputsLength;
                inputIndex++
            ) {
                const input = tx.getInput(inputIndex);
                if (input.tapKeySig) {
                    tx.updateInput(inputIndex, {
                        finalScriptWitness: [input.tapKeySig],
                    });
                    sawTapKeySig = true;
                }

                if (input.tapScriptSig && input.tapScriptSig.length > 0) {
                    sawTapScriptSig = true;
                }
            }

            // If we already wrote finalScriptWitness for every key-path input
            // and no script-path inputs exist, the tx is finalized. Otherwise
            // let .finalize() handle the remaining inputs.
            const keyPathAlreadyFinalized = sawTapKeySig && !sawTapScriptSig;
            if (!keyPathAlreadyFinalized) {
                tx.finalize();
            }

            const rawHex = hex.encode(tx.toBytes());
            await onchain.broadcastTransaction(rawHex);

            steps.push({
                type: "broadcast",
                txid,
                description: `Broadcast virtual tx: ${txid}`,
            });
        } catch (err) {
            if (isAlreadyBroadcastError(err)) {
                steps.push({
                    type: "broadcast",
                    txid,
                    description: `Already in mempool: ${txid}`,
                });
            } else {
                errors.push(
                    `Failed to broadcast tx ${txid}: ${errorMessage(err)}`
                );
                steps.push({
                    type: "broadcast",
                    txid,
                    description: `Broadcast failed: ${txid}`,
                });
                return { success: false, steps, errors };
            }
        }
    }

    // broadcastOrder.order is root→leaf, so the leaf is the last entry.
    let finalTxid =
        broadcastOrder.order[broadcastOrder.order.length - 1] ??
        vtxoOutpoint.txid;

    if (
        errors.length === 0 &&
        (options?.identity || options?.outputAddress || options?.network)
    ) {
        if (!options.identity || !options.outputAddress || !options.network) {
            errors.push(
                "Final claim requires identity, outputAddress, and network"
            );
        } else if (!data.claimInput) {
            errors.push(
                "Stored exit data does not include claim input details for the final claim"
            );
        } else {
            let claim;
            try {
                claim = await buildFinalClaimTransaction(
                    data.claimInput,
                    options.outputAddress,
                    options.network,
                    options.identity,
                    onchain,
                    options.preimage
                );
            } catch (err) {
                // buildFinalClaimTransaction can throw for unindexed
                // claim inputs, bad addresses, sub-dust amounts, or
                // signing failures. Surface those as a failed result
                // instead of rejecting the whole function.
                errors.push(
                    `Failed to build final claim tx: ${errorMessage(err)}`
                );
                return { success: false, steps, errors };
            }

            if (claim.waitStep) {
                steps.push(claim.waitStep);
                errors.push(claim.waitStep.description);
            } else if (claim.tx) {
                try {
                    await onchain.broadcastTransaction(claim.tx.hex);
                    finalTxid = claim.tx.id;
                    steps.push({
                        type: "broadcast",
                        txid: claim.tx.id,
                        description: `Broadcast final claim tx: ${claim.tx.id}`,
                    });
                } catch (err) {
                    if (isAlreadyBroadcastError(err)) {
                        finalTxid = claim.tx.id;
                        steps.push({
                            type: "broadcast",
                            txid: claim.tx.id,
                            description: `Final claim already in mempool: ${claim.tx.id}`,
                        });
                    } else {
                        errors.push(
                            `Failed to broadcast final claim tx ${claim.tx.id}: ${errorMessage(err)}`
                        );
                    }
                }
            }
        }
    }

    steps.push({
        type: "done",
        txid: finalTxid,
        description: "Sovereign exit transaction sequence complete",
    });

    return {
        success: errors.length === 0,
        steps,
        finalTxid,
        errors,
    };
}

async function buildFinalClaimTransaction(
    claimInput: ExitClaimInput,
    outputAddress: string,
    network: Network,
    identity: Identity,
    onchain: OnchainProvider,
    preimage?: Uint8Array[]
): Promise<{
    tx?: Transaction;
    waitStep?: SovereignExitStep;
}> {
    const txStatus = await onchain.getTxStatus(claimInput.txid);
    if (!txStatus.confirmed) {
        return {
            waitStep: {
                type: "wait",
                txid: claimInput.txid,
                description: `Final claim unavailable until ${claimInput.txid} is confirmed`,
            },
        };
    }

    const tapTree = hex.decode(claimInput.tapTree);
    const vtxoScript = VtxoScript.decode(tapTree);
    const chainTip = await onchain.getChainTip();
    // Pass signer pubkey so a VHTLC-style script doesn't pick a leaf
    // requiring other parties' witnesses just because its timelock
    // elapsed first. buildFinalClaimTransaction will then try to sign
    // a leaf that actually lists this caller's pubkey.
    const signerPubkey = await identity.xOnlyPublicKey();
    const hasPreimage = Boolean(preimage && preimage.length > 0);
    const exit = availableExitPath(
        { height: txStatus.blockHeight, time: txStatus.blockTime },
        { height: chainTip.height, time: chainTip.time },
        vtxoScript,
        signerPubkey,
        hasPreimage
    );

    if (!exit) {
        return {
            waitStep: {
                type: "wait",
                txid: claimInput.txid,
                description: `Final claim timelock is not yet spendable for ${claimInput.txid}`,
            },
        };
    }

    const spendingLeaf = vtxoScript.findLeaf(hex.encode(exit.script));
    // Encode BIP-68 nSequence from the exit leaf's CSV timelock
    const csvValue = Number(exit.params.timelock.value);
    const csvSequence =
        exit.params.timelock.type === "seconds"
            ? (1 << 22) | Math.ceil(csvValue / 512) // BIP-68 time-based
            : csvValue; // BIP-68 block-based

    const tx = new Transaction({ version: 2 });
    tx.addInput({
        txid: hex.decode(claimInput.txid),
        index: claimInput.vout,
        tapLeafScript: [spendingLeaf],
        sequence: csvSequence,
        witnessUtxo: {
            amount: BigInt(claimInput.value),
            script: vtxoScript.pkScript,
        },
        sighashType: SigHash.DEFAULT,
    });

    // Condition-based leaves (e.g. VHTLC unilateralClaim) need the hash
    // preimage attached as a PSBT unknown field so .finalize() can build
    // a satisfying witness stack.
    if (exit.type === TapscriptType.ConditionCSVMultisig) {
        if (!preimage || preimage.length === 0) {
            // Defensive: availableExitPath shouldn't return a condition
            // leaf when no preimage was passed, but fail loudly if it does
            // rather than producing an unfinalizable tx.
            throw new Error(
                "Selected exit leaf requires a preimage; pass options.preimage"
            );
        }
        setArkPsbtField(tx, 0, ConditionWitness, preimage);
    }

    let feeRate = await onchain.getFeeRate();
    if (!feeRate || feeRate < 1) {
        feeRate = 1;
    }

    const estimatedVsize = estimateFinalClaimVsize(
        spendingLeaf,
        exit.type,
        exit.params.pubkeys.length,
        preimage
    );
    const FINAL_CLAIM_MIN_FEE_SATS = 200;
    const fee = BigInt(
        Math.max(FINAL_CLAIM_MIN_FEE_SATS, Math.ceil(feeRate * estimatedVsize))
    );
    const sendAmount = BigInt(claimInput.value) - fee;
    if (sendAmount <= 0n) {
        throw new Error("Final claim amount is not sufficient to cover fees");
    }

    Address(network).decode(outputAddress);
    tx.addOutputAddress(outputAddress, sendAmount, network);

    const signedTx = await identity.sign(tx);
    signedTx.finalize();

    return { tx: signedTx };
}

/**
 * Returns txids in root→leaf order (roots first). "Root" means no
 * dependency on any other txid in the input set (its inputs reference
 * the commitment tx or some tx outside the set).
 *
 * Safer than `[...chainTxIds].reverse()`: we derive the dependency
 * graph from the stored PSBTs, so a corrupted `data.chain` order
 * fails pre-flight instead of broadcasting in the wrong order.
 */
function topoSortChainTxIds(
    chainTxIds: string[],
    virtualTxs: Record<string, string>
): { order: string[]; error?: string } {
    const set = new Set(chainTxIds);
    const deps = new Map<string, Set<string>>();

    for (const txid of chainTxIds) {
        const psbt = virtualTxs[txid];
        if (!psbt) {
            return {
                order: [],
                error: `Missing virtual tx PSBT for ${txid}`,
            };
        }

        let tx: Transaction;
        try {
            tx = parseVirtualTx(txid, psbt);
        } catch (err) {
            // Integrity failures mean the stored PSBT was substituted and
            // would broadcast a different tx than the chain promises —
            // abort rather than depend on the broadcast loop to notice.
            // Pure parse failures (unparseable PSBT) stay lenient: the
            // broadcast loop will reject them when it tries to finalize,
            // and an already-confirmed tx is skipped there.
            if (err instanceof VirtualTxIntegrityError) {
                return { order: [], error: err.message };
            }
            deps.set(txid, new Set());
            continue;
        }

        const parents = new Set<string>();
        for (let i = 0; i < tx.inputsLength; i++) {
            const input = tx.getInput(i);
            if (!input.txid) continue;
            const parentTxid = hex.encode(input.txid);
            // Ignore self-references — impossible in real PSBTs but test
            // fixtures sometimes use the tx's own txid as a placeholder input.
            if (parentTxid === txid) continue;
            if (set.has(parentTxid)) parents.add(parentTxid);
        }
        deps.set(txid, parents);
    }

    // Kahn's algorithm: repeatedly pick nodes whose deps are already emitted.
    const order: string[] = [];
    const emitted = new Set<string>();
    while (order.length < chainTxIds.length) {
        const ready = chainTxIds.find(
            (id) =>
                !emitted.has(id) &&
                [...(deps.get(id) ?? [])].every((p) => emitted.has(p))
        );
        if (!ready) {
            return {
                order: [],
                error: "Cycle or disconnected graph in virtual tx chain",
            };
        }
        order.push(ready);
        emitted.add(ready);
    }

    return { order };
}

/**
 * Conservative vsize estimate for a 1-in 1-out taproot script-path spend
 * of the given leaf. Accounts for:
 * - a P2TR output (~43 vB)
 * - base input + segwit marker/flag
 * - the schnorr signature per required pubkey
 * - condition-leaf preimage bytes, if supplied
 * - the leaf script and its control block
 *
 * Underestimating here means the final claim pays below the requested
 * fee rate — bad during fee spikes, which is exactly when unilateral
 * exits happen.
 */
function estimateFinalClaimVsize(
    spendingLeaf: import("../script/base").TapLeafScript,
    exitType: TapscriptType,
    numPubkeys: number,
    preimage?: Uint8Array[]
): number {
    const [controlBlockMeta, scriptWithVersion] = spendingLeaf;
    // scriptWithVersion is the leaf script followed by a 1-byte leaf version.
    const scriptLen = Math.max(0, scriptWithVersion.length - 1);
    const cbLen = 33 + 32 * controlBlockMeta.merklePath.length;

    // 1 byte for each witness-stack item length prefix is accurate for
    // items <= 252 bytes, which is true for all of these.
    let witnessBytes = 1; // stack-count varint
    if (exitType === TapscriptType.ConditionCSVMultisig && preimage) {
        for (const p of preimage) {
            witnessBytes += 1 + p.length;
        }
    }
    witnessBytes += numPubkeys * (1 + 64); // schnorr default-sighash sig per signer
    witnessBytes += 1 + scriptLen;
    witnessBytes += 1 + cbLen;

    // Non-witness: version(4) + input-count(1) + (32+4 txid/vout + 1
    // scriptsig-len + 4 sequence) + output-count(1) + (8 amount + 1
    // script-len + 34 P2TR script) + locktime(4) = 94 bytes.
    const nonWitnessBytes = 94;
    const weight = nonWitnessBytes * 4 + 2 /* marker+flag */ + witnessBytes;
    return Math.ceil(weight / 4);
}

function availableExitPath(
    confirmedAt: { height: number; time: number },
    current: { height: number; time: number },
    vtxoScript: VtxoScript,
    // If provided, only consider exit leaves that require this pubkey to
    // sign. Without this filter, a VHTLC-style script with multiple exits
    // (e.g. receiver-with-preimage, sender-with-CSV) would return whichever
    // path elapsed first, even if the caller can't actually sign it.
    signerPubkey?: Uint8Array,
    // Condition leaves (e.g. VHTLC unilateralClaim) cannot be finalized
    // without a hash preimage. Skip them when the caller didn't supply
    // one so canSovereignExit reflects what sovereignExit can actually
    // build.
    hasPreimage?: boolean
): CSVMultisigTapscript.Type | ConditionCSVMultisigTapscript.Type | undefined {
    for (const exit of vtxoScript.exitPaths()) {
        if (
            signerPubkey &&
            !exit.params.pubkeys.some(
                (pk) => compareBytes(pk, signerPubkey) === 0
            )
        ) {
            continue;
        }
        if (exit.type === TapscriptType.ConditionCSVMultisig && !hasPreimage) {
            continue;
        }
        if (exit.params.timelock.type === "blocks") {
            if (
                current.height >=
                confirmedAt.height + Number(exit.params.timelock.value)
            ) {
                return exit;
            }
            continue;
        }

        if (
            current.time >=
            confirmedAt.time + Number(exit.params.timelock.value)
        ) {
            return exit;
        }
    }

    return undefined;
}
