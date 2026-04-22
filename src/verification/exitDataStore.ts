import type { Outpoint, VirtualCoin } from "../wallet";
import type { ChainTx } from "../providers/indexer";
import { ChainTxType } from "../providers/indexer";
import type { TxTreeNode } from "../tree/txTree";
import { hex } from "@scure/base";

/**
 * Structural type used by wallet wiring and sovereignExit to accept any
 * persistence backend for unilateral exit data. The only implementation
 * shipped with the SDK is `ExitDataStore` in ./exitDataRepository.ts,
 * which is storage-adapter backed; tests compose it with
 * `InMemoryStorageAdapter`.
 */

export interface ExitClaimInput {
    txid: string;
    vout: number;
    value: number;
    tapTree: string;
}

/**
 * All data needed to perform a unilateral exit for a single VTXO,
 * without contacting the ASP's IndexerService.
 */
export interface ExitData {
    /** The VTXO outpoint this exit data belongs to */
    vtxoOutpoint: Outpoint;
    /**
     * Primary commitment txid (first COMMITMENT entry in chain). Kept
     * for display; callers that need to verify *every* commitment
     * (multi-batch VTXOs) should iterate `chain` directly and filter
     * by `ChainTxType.COMMITMENT`.
     */
    commitmentTxid: string;
    /** The full VTXO chain from leaf to commitment (all ChainTx entries) */
    chain: ChainTx[];
    /** All presigned virtual transaction PSBTs (base64) keyed by txid */
    virtualTxs: Record<string, string>;
    /** The tree structure (txid + children mapping) for reconstruction */
    treeNodes: TxTreeNode[];
    /** Optional local claim input data for the final unilateral-exit spend */
    claimInput?: ExitClaimInput;
    /** Timestamp when this exit data was stored */
    storedAt: number;
}

export interface ExitDataRepository {
    /** Save exit data for a VTXO */
    saveExitData(data: ExitData): Promise<void>;
    /** Get exit data for a specific VTXO outpoint */
    getExitData(outpoint: Outpoint): Promise<ExitData | null>;
    /** Get all stored exit data */
    getAllExitData(): Promise<ExitData[]>;
    /** Delete exit data for a specific VTXO (e.g. after successful exit or spend) */
    deleteExitData(outpoint: Outpoint): Promise<void>;
    /** Delete all exit data */
    clear(): Promise<void>;
}

/**
 * Analyzes a VTXO chain to determine all data required for unilateral exit.
 *
 * Given a VTXO and its chain from the indexer, identifies:
 * - The full chain of presigned transactions from leaf to batch root
 * - All intermediate virtual transactions and their PSBTs
 * - Merkle proofs and witness data needed to finalize each step
 *
 * Returns an ExitData object containing everything needed to exit
 * without contacting the ASP.
 */
export function collectExitData(
    vtxo: VirtualCoin,
    chain: ChainTx[],
    virtualTxs: Record<string, string>,
    treeNodes: TxTreeNode[]
): ExitData {
    const commitmentEntry = chain.find(
        (c) => c.type === ChainTxType.COMMITMENT
    );
    const claimInput =
        "tapTree" in vtxo && vtxo.tapTree instanceof Uint8Array
            ? {
                  txid: vtxo.txid,
                  vout: vtxo.vout,
                  value: vtxo.value,
                  tapTree: hex.encode(vtxo.tapTree),
              }
            : undefined;

    return {
        vtxoOutpoint: { txid: vtxo.txid, vout: vtxo.vout },
        commitmentTxid: commitmentEntry?.txid ?? "",
        chain,
        virtualTxs,
        treeNodes,
        claimInput,
        storedAt: Date.now(),
    };
}

export function validateExitData(data: ExitData): {
    valid: boolean;
    errors: string[];
} {
    const errors: string[] = [];

    if (!data.commitmentTxid) {
        errors.push("Missing commitment txid");
    }

    if (!data.chain || data.chain.length === 0) {
        errors.push("Chain is empty");
    }

    // Only TREE / ARK entries carry virtual PSBTs. COMMITMENT entries
    // live onchain, CHECKPOINT entries have no PSBT by design — see
    // buildExitDataForVtxo's matching filter. Checking every entry
    // here would reject any chain that includes a checkpoint.
    for (const entry of data.chain) {
        if (entry.type !== ChainTxType.TREE && entry.type !== ChainTxType.ARK) {
            continue;
        }
        if (!data.virtualTxs[entry.txid]) {
            errors.push(
                `Missing virtual tx PSBT for chain entry ${entry.txid}`
            );
        }
    }

    return { valid: errors.length === 0, errors };
}
