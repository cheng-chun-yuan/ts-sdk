import { hex, base64 } from "@scure/base";
import { tapLeafHash } from "@scure/btc-signer/payment.js";
import type { Outpoint, VirtualCoin } from "../wallet";
import type { IndexerProvider } from "../providers/indexer";
import { ChainTxType } from "../providers/indexer";
import type { OnchainProvider } from "../providers/onchain";
import type { RelativeTimelock } from "../script/tapscript";
import { CSVMultisigTapscript } from "../script/tapscript";
import {
    findInputIndexSpendingOutpoint,
    TxTree,
    TxTreeNode,
} from "../tree/txTree";
import { validateVtxoTxGraph } from "../tree/validation";
import { verifyOnchainAnchor } from "./onchainAnchorVerifier";
import { verifyCheckpointTransactions } from "./checkpointVerifier";
import {
    verifyTreeSignatures,
    verifyCosignerKeys,
    verifyInternalKeysUnspendable,
} from "./signatureVerifier";
import { Transaction } from "../utils/transaction";

function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

export interface PartialChecks {
    signaturesValid?: boolean;
    internalKeysUnspendable?: boolean;
    amountConservation?: boolean;
    dagStructure?: boolean;
}

export interface VtxoVerificationResult {
    valid: boolean;
    vtxoOutpoint: Outpoint;
    /** Primary commitment txid (first in chain). Use commitmentTxids for all. */
    commitmentTxid: string;
    /** All commitment txids found in the DAG (a VTXO can span multiple batches). */
    commitmentTxids: string[];
    confirmationDepth: number;
    chainLength: number;
    errors: string[];
    warnings: string[];
    /** For preconfirmed VTXOs: which checks passed without onchain anchoring */
    partialChecks?: PartialChecks;
}

export interface VtxoVerificationOptions {
    minConfirmationDepth?: number;
    verifySignatures?: boolean;
}

const BATCH_OUTPUT_INDEX = 0;
const MAX_ERRORS = 100;

type PushError = (msg: string) => void;

function collectErrors<T extends { valid: boolean; error?: string }>(
    results: T[],
    format: (r: T) => string
): string[] {
    return results.filter((r) => !r.valid).map(format);
}

function getActualParentTxids(tx: Transaction): Set<string> {
    const parents = new Set<string>();
    for (let inputIndex = 0; inputIndex < tx.inputsLength; inputIndex++) {
        const input = tx.getInput(inputIndex);
        if (input.txid) {
            parents.add(hex.encode(input.txid));
        }
    }
    return parents;
}

function validatePathTx(
    txid: string,
    tx: Transaction,
    pathTxs: Map<string, Transaction>,
    commitmentTxidSet: Set<string>,
    declaredParents: string[],
    pushError: PushError,
    warnings: string[]
): void {
    let totalInputAmount = 0n;
    let hasKnownInputAmount = false;
    let missingInputAmount = false;

    for (let inputIndex = 0; inputIndex < tx.inputsLength; inputIndex++) {
        const input = tx.getInput(inputIndex);
        if (!input.txid) {
            pushError(`DAG tx ${txid} input ${inputIndex} has no txid`);
            continue;
        }

        const parentTxid = hex.encode(input.txid);
        if (!commitmentTxidSet.has(parentTxid) && !pathTxs.has(parentTxid)) {
            pushError(
                `DAG tx ${txid} input ${inputIndex} references unknown parent ${parentTxid}`
            );
        }

        let inputAmount = input.witnessUtxo?.amount;
        if (inputAmount === undefined) {
            const parentTx = pathTxs.get(parentTxid);
            if (parentTx) {
                const parentOutputIndex = input.index ?? 0;
                inputAmount = parentTx.getOutput(parentOutputIndex)?.amount;
            }
        }

        if (inputAmount !== undefined) {
            totalInputAmount += inputAmount;
            hasKnownInputAmount = true;
        } else {
            missingInputAmount = true;
        }
    }

    const actualParents = getActualParentTxids(tx);
    const declaredParentSet = new Set(declaredParents);
    const missingParents = [...actualParents].filter(
        (parentTxid) => !declaredParentSet.has(parentTxid)
    );
    const unexpectedParents = declaredParents.filter(
        (parentTxid) => !actualParents.has(parentTxid)
    );

    if (missingParents.length > 0) {
        pushError(
            `Chain metadata mismatch for tx ${txid}: missing parents ${missingParents.join(", ")}`
        );
    }
    if (unexpectedParents.length > 0) {
        pushError(
            `Chain metadata mismatch for tx ${txid}: unexpected parents ${unexpectedParents.join(", ")}`
        );
    }

    if (hasKnownInputAmount && !missingInputAmount) {
        let outputSum = 0n;
        for (
            let outputIndex = 0;
            outputIndex < tx.outputsLength;
            outputIndex++
        ) {
            const output = tx.getOutput(outputIndex);
            if (output?.amount !== undefined) outputSum += output.amount;
        }
        if (outputSum > totalInputAmount) {
            pushError(
                `DAG tx ${txid} outputs (${outputSum}) exceed inputs (${totalInputAmount})`
            );
        }
        return;
    }

    warnings.push(
        `DAG tx ${txid}: could not determine all input amounts for conservation check`
    );
}

function buildPathTreeNodes(
    pathTxids: string[],
    txs: string[],
    pathTxs: Map<string, Transaction>,
    pushError: PushError
): TxTreeNode[] {
    const childrenByParent = new Map<string, Record<number, string>>();
    for (const txid of pathTxids) {
        childrenByParent.set(txid, {});
    }

    for (const [childTxid, tx] of pathTxs) {
        for (let inputIndex = 0; inputIndex < tx.inputsLength; inputIndex++) {
            const input = tx.getInput(inputIndex);
            if (!input.txid) continue;

            const parentTxid = hex.encode(input.txid);
            if (!pathTxs.has(parentTxid)) continue;

            const outputIndex = input.index ?? 0;
            const parentChildren = childrenByParent.get(parentTxid)!;
            const existingChild = parentChildren[outputIndex];
            if (existingChild && existingChild !== childTxid) {
                pushError(
                    `Multiple child txs reference parent ${parentTxid} output ${outputIndex}: ${existingChild}, ${childTxid}`
                );
                continue;
            }
            parentChildren[outputIndex] = childTxid;
        }
    }

    return pathTxids.map((txid, index) => ({
        txid,
        tx: txs[index],
        children: childrenByParent.get(txid) ?? {},
    }));
}

function findRootCommitmentInput(
    rootTx: Transaction,
    commitmentTxids: string[]
): { txid: string; inputIndex: number } | null {
    for (const commitmentTxid of commitmentTxids) {
        const inputIndex = findInputIndexSpendingOutpoint(
            rootTx,
            commitmentTxid,
            BATCH_OUTPUT_INDEX
        );
        if (inputIndex !== null) {
            return { txid: commitmentTxid, inputIndex };
        }
    }

    return null;
}

/**
 * Verifies a single VTXO by traversing the DAG from the VTXO (root)
 * backward to the batch output commitment transactions (leaves).
 *
 * The VTXO is the most recent transaction. Going backward in the
 * virtual mempool, we trace through intermediate virtual transactions
 * until we find all the batch outputs (commitment txs) anchored onchain.
 *
 * A VTXO can be linked to multiple commitment txs when it results from
 * an Ark transaction whose inputs came from different batches. All
 * commitment txs are independently verified onchain.
 */
export async function verifyVtxo(
    vtxo: VirtualCoin,
    indexer: IndexerProvider,
    onchain: OnchainProvider,
    serverInfo: {
        pubkey: Uint8Array;
        sweepInterval: RelativeTimelock;
    },
    options?: VtxoVerificationOptions
): Promise<VtxoVerificationResult> {
    const minDepth = options?.minConfirmationDepth ?? 6;
    const shouldVerifySigs = options?.verifySignatures ?? true;
    const errors: string[] = [];
    const warnings: string[] = [];
    const outpoint: Outpoint = { txid: vtxo.txid, vout: vtxo.vout };

    const pushError = (msg: string) => {
        if (errors.length < MAX_ERRORS) errors.push(msg);
        else if (errors.length === MAX_ERRORS)
            errors.push(`... truncated (>${MAX_ERRORS} errors)`);
    };

    const isPreconfirmed = vtxo.virtualStatus?.state === "preconfirmed";

    // ═══ Phase 1: Parse — do I have a well-formed tree? ═══

    // Step 1: Get the DAG from the VTXO (root) back to commitment txs (leaves)
    let vtxoChain: Awaited<ReturnType<IndexerProvider["getVtxoChain"]>> | null =
        null;
    try {
        vtxoChain = await indexer.getVtxoChain(outpoint);
        if (!vtxoChain.chain || vtxoChain.chain.length === 0) {
            pushError("Empty VTXO chain returned from indexer");
            return makeResult(outpoint, [], 0, 0, errors, warnings);
        }
    } catch (err) {
        pushError(`Failed to fetch VTXO chain: ${errorMessage(err)}`);
        return makeResult(outpoint, [], 0, 0, errors, warnings);
    }

    // Find ALL commitment txs in the DAG (a VTXO can span multiple batches)
    const allCommitmentTxids = vtxoChain.chain
        .filter((c) => c.type === ChainTxType.COMMITMENT)
        .map((c) => c.txid);

    if (allCommitmentTxids.length === 0) {
        pushError("No commitment transaction found in VTXO chain");
        return makeResult(outpoint, [], 0, 0, errors, warnings);
    }

    const commitmentTxidSet = new Set(allCommitmentTxids);

    // Validate commitment txid consistency with virtualStatus
    const statusCommitmentTxIds = vtxo.virtualStatus?.commitmentTxIds ?? [];
    if (statusCommitmentTxIds.length > 0) {
        for (const statusId of statusCommitmentTxIds) {
            if (!commitmentTxidSet.has(statusId)) {
                pushError(
                    `Commitment tx ${statusId} from virtualStatus not found in chain`
                );
            }
        }
    }

    // Step 2: Fetch only the virtual txs in the DAG (non-commitment entries)
    let tree: TxTree;
    let chainLength: number;
    let pathTxs = new Map<string, Transaction>();
    try {
        const chainEntryByTxid = new Map(
            vtxoChain.chain.map((entry) => [entry.txid, entry] as const)
        );
        const pathTxids = vtxoChain.chain
            .filter(
                (c) => c.type === ChainTxType.TREE || c.type === ChainTxType.ARK
            )
            .map((c) => c.txid);

        if (pathTxids.length === 0) {
            pushError("No virtual transactions in VTXO chain");
            return makeResult(
                outpoint,
                allCommitmentTxids,
                0,
                0,
                errors,
                warnings
            );
        }

        const { txs } = await indexer.getVirtualTxs(pathTxids);
        if (txs.length !== pathTxids.length) {
            pushError(
                `Virtual tx count mismatch: expected ${pathTxids.length}, got ${txs.length}`
            );
            return makeResult(
                outpoint,
                allCommitmentTxids,
                0,
                pathTxids.length,
                errors,
                warnings
            );
        }

        // Parse each PSBT
        pathTxs = new Map<string, Transaction>();
        for (let i = 0; i < pathTxids.length; i++) {
            pathTxs.set(
                pathTxids[i],
                Transaction.fromPSBT(base64.decode(txs[i]))
            );
        }

        for (const [txid, tx] of pathTxs) {
            const chainEntry = chainEntryByTxid.get(txid);
            validatePathTx(
                txid,
                tx,
                pathTxs,
                commitmentTxidSet,
                chainEntry?.spends ?? [],
                pushError,
                warnings
            );
        }

        const pathNodes = buildPathTreeNodes(
            pathTxids,
            txs,
            pathTxs,
            pushError
        );

        tree = TxTree.create(pathNodes);
        chainLength = pathTxids.length;
    } catch (err) {
        pushError(`Failed to verify VTXO DAG: ${errorMessage(err)}`);
        return makeResult(outpoint, allCommitmentTxids, 0, 0, errors, warnings);
    }

    // Track partial check results (used for preconfirmed VTXOs)
    const partial: PartialChecks = {};

    // ═══ Phase 2: Shape — is the tree cryptographically sound? ═══

    // Step 3: Validate structure + cosigner keys (requires onchain data)
    if (!isPreconfirmed) {
        try {
            const sweepScript = CSVMultisigTapscript.encode({
                timelock: serverInfo.sweepInterval,
                pubkeys: [serverInfo.pubkey],
            }).script;
            const sweepTapTreeRoot = tapLeafHash(sweepScript);

            const rootCommitmentInput = findRootCommitmentInput(
                tree.root,
                allCommitmentTxids
            );
            const primaryCommitTxid =
                rootCommitmentInput?.txid ?? allCommitmentTxids[0];

            const primaryTxHex = await onchain.getTxHex(primaryCommitTxid);
            const primaryTx = Transaction.fromRaw(hex.decode(primaryTxHex));

            validateVtxoTxGraph(tree, primaryTx, sweepTapTreeRoot);

            collectErrors(
                verifyCosignerKeys(tree, sweepTapTreeRoot),
                (r) =>
                    `Cosigner key verification failed for tx ${r.txid} child ${r.childIndex}: ${r.error}`
            ).forEach(pushError);
        } catch (err) {
            pushError(`Tree structure validation failed: ${errorMessage(err)}`);
        }
    }

    // Step 3b: Verify internal keys use unspendable NUMS point
    try {
        const numsErrors = collectErrors(
            verifyInternalKeysUnspendable(tree),
            (r) =>
                `Unspendable key check failed for tx ${r.txid} input ${r.inputIndex}: ${r.error}`
        );
        numsErrors.forEach(pushError);
        partial.internalKeysUnspendable = numsErrors.length === 0;
    } catch (err) {
        pushError(`Internal key verification error: ${errorMessage(err)}`);
        partial.internalKeysUnspendable = false;
    }

    // Step 3c: Verify checkpoint transactions in the chain
    if (vtxoChain) {
        const checkpointResults = verifyCheckpointTransactions(
            vtxoChain.chain,
            serverInfo.sweepInterval
        );
        for (const checkpoint of checkpointResults) {
            checkpoint.errors.forEach((error) =>
                pushError(
                    `Checkpoint verification failed for ${checkpoint.txid}: ${error}`
                )
            );
            warnings.push(...checkpoint.warnings);
        }
    }

    // Step 3d: Verify VTXO exists in the DAG and metadata matches the leaf output
    let dagOk = true;
    try {
        const leafTx = tree.find(vtxo.txid);
        if (!leafTx) {
            pushError(`VTXO ${vtxo.txid}:${vtxo.vout} not found in DAG`);
            dagOk = false;
        } else if (leafTx.root.outputsLength <= vtxo.vout) {
            pushError(
                `VTXO output index ${vtxo.vout} out of bounds in tx ${vtxo.txid}`
            );
            dagOk = false;
        } else {
            // Otherwise an indexer can hand back a real outpoint with an
            // inflated value or stale script and verifyVtxo would still pass.
            const output = leafTx.root.getOutput(vtxo.vout);
            if (
                output?.amount !== undefined &&
                BigInt(vtxo.value) !== output.amount
            ) {
                pushError(
                    `VTXO amount mismatch: claimed ${vtxo.value}, leaf tx output is ${output.amount}`
                );
                dagOk = false;
            }
            if (vtxo.script && output?.script) {
                const claimed = vtxo.script.toLowerCase();
                const actual = hex.encode(output.script);
                if (claimed !== actual) {
                    pushError(
                        `VTXO script mismatch: claimed ${claimed}, leaf tx output is ${actual}`
                    );
                    dagOk = false;
                }
            }
        }
    } catch (err) {
        pushError(`VTXO lookup error: ${errorMessage(err)}`);
        dagOk = false;
    }
    partial.dagStructure = dagOk;

    // ═══ Phase 3: Signatures — are the presigned txs real? ═══

    // Step 4: Verify signatures
    if (shouldVerifySigs) {
        try {
            const sigErrors = collectErrors(
                verifyTreeSignatures(tree),
                (r) =>
                    `Signature verification failed for tx ${r.txid} input ${r.inputIndex}: ${r.error}`
            );
            sigErrors.forEach(pushError);
            partial.signaturesValid = sigErrors.length === 0;
        } catch (err) {
            pushError(`Signature verification error: ${errorMessage(err)}`);
            partial.signaturesValid = false;
        }
    }

    // For preconfirmed VTXOs: return early with partial checks, valid = false
    if (isPreconfirmed) {
        warnings.push(
            "VTXO is preconfirmed — onchain anchoring skipped, partial checks only"
        );
        const result = makeResult(
            outpoint,
            allCommitmentTxids,
            0,
            chainLength,
            [
                ...errors,
                "VTXO is preconfirmed and has no commitment transaction yet",
            ],
            warnings
        );
        result.partialChecks = partial;
        return result;
    }

    // ═══ Phase 4: Anchor — does the tree connect to Bitcoin? ═══

    // Step 5: Verify onchain anchoring for ALL commitment txs.
    // Source the expected (amount, script) from the spending child PSBT's
    // witnessUtxo. The on-chain anchor verifier then re-fetches the commitment
    // and compares — so a forged child PSBT prevout can't ride a real anchor.
    const commitOutputIndexMap = new Map<string, number>();
    const commitSpenderMap = new Map<string, string>();
    const commitWitnessUtxoMap = new Map<
        string,
        { amount: bigint; script: Uint8Array }
    >();
    for (const [childTxid, tx] of pathTxs) {
        for (let idx = 0; idx < tx.inputsLength; idx++) {
            const input = tx.getInput(idx);
            if (!input.txid) continue;
            const parentTxid = hex.encode(input.txid);
            if (commitmentTxidSet.has(parentTxid)) {
                commitOutputIndexMap.set(
                    parentTxid,
                    input.index ?? BATCH_OUTPUT_INDEX
                );
                commitSpenderMap.set(parentTxid, childTxid);
                if (input.witnessUtxo) {
                    commitWitnessUtxoMap.set(parentTxid, {
                        amount: input.witnessUtxo.amount,
                        script: input.witnessUtxo.script,
                    });
                }
            }
        }
    }

    let minConfirmationDepth = Infinity;
    // Fetch chain tip once and share across all anchor checks in this verify call.
    const sharedChainTip = await onchain.getChainTip().catch(() => undefined);
    for (const commitTxid of allCommitmentTxids) {
        try {
            const outputIndex =
                commitOutputIndexMap.get(commitTxid) ?? BATCH_OUTPUT_INDEX;

            const witnessUtxo = commitWitnessUtxoMap.get(commitTxid);
            if (!witnessUtxo) {
                pushError(
                    `Spending child of commitment tx ${commitTxid} is missing witnessUtxo — cannot verify anchor`
                );
                continue;
            }

            const anchorResult = await verifyOnchainAnchor(
                commitTxid,
                outputIndex,
                witnessUtxo.amount,
                witnessUtxo.script,
                onchain,
                minDepth,
                commitSpenderMap.get(commitTxid),
                sharedChainTip
            );

            if (anchorResult.confirmationDepth < minConfirmationDepth) {
                minConfirmationDepth = anchorResult.confirmationDepth;
            }
            anchorResult.errors.forEach(pushError);
            warnings.push(...anchorResult.warnings);
        } catch (err) {
            pushError(
                `Onchain anchor verification error for ${commitTxid}: ${errorMessage(err)}`
            );
        }
    }

    const confirmationDepth =
        minConfirmationDepth === Infinity ? 0 : minConfirmationDepth;

    return makeResult(
        outpoint,
        allCommitmentTxids,
        confirmationDepth,
        chainLength,
        errors,
        warnings
    );
}

export async function verifyAllVtxos(
    vtxos: VirtualCoin[],
    indexer: IndexerProvider,
    onchain: OnchainProvider,
    serverInfo: {
        pubkey: Uint8Array;
        sweepInterval: RelativeTimelock;
    },
    options?: VtxoVerificationOptions
): Promise<Map<string, VtxoVerificationResult>> {
    const results = new Map<string, VtxoVerificationResult>();
    if (vtxos.length === 0) return results;

    const CONCURRENCY = 5;
    for (let i = 0; i < vtxos.length; i += CONCURRENCY) {
        const batch = vtxos.slice(i, i + CONCURRENCY);
        const batchResults = await Promise.all(
            batch.map((v) =>
                verifyVtxo(v, indexer, onchain, serverInfo, options)
            )
        );

        for (let j = 0; j < batch.length; j++) {
            const vtxo = batch[j];
            results.set(`${vtxo.txid}:${vtxo.vout}`, batchResults[j]);
        }
    }

    return results;
}

function makeResult(
    vtxoOutpoint: Outpoint,
    commitmentTxids: string[],
    confirmationDepth: number,
    chainLength: number,
    errors: string[],
    warnings: string[]
): VtxoVerificationResult {
    return {
        valid: errors.length === 0,
        vtxoOutpoint,
        commitmentTxid: commitmentTxids[0] ?? "",
        commitmentTxids,
        confirmationDepth,
        chainLength,
        errors,
        warnings,
    };
}
