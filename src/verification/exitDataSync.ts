import { hex } from "@scure/base";
import type { IndexerProvider } from "../providers/indexer";
import { ChainTxType } from "../providers/indexer";
import type { Outpoint, VirtualCoin } from "../wallet";
import type { ExitData, ExitDataRepository } from "./exitDataStore";
import { collectExitData } from "./exitDataStore";
import { parseVirtualTx } from "./virtualTx";
import type { TxTreeNode } from "../tree/txTree";
import type { Transaction } from "../utils/transaction";

function buildTreeNodes(txids: string[], txs: string[]): TxTreeNode[] {
    const parsed = new Map<string, Transaction>();
    for (let i = 0; i < txids.length; i++) {
        parsed.set(txids[i], parseVirtualTx(txids[i], txs[i]));
    }

    const childrenByParent = new Map<string, Record<number, string>>();
    for (const txid of txids) {
        childrenByParent.set(txid, {});
    }

    for (const [childTxid, tx] of parsed) {
        for (let inputIndex = 0; inputIndex < tx.inputsLength; inputIndex++) {
            const input = tx.getInput(inputIndex);
            if (!input.txid) continue;
            const parentTxid = hex.encode(input.txid);
            if (!parsed.has(parentTxid)) continue;
            const parentChildren = childrenByParent.get(parentTxid)!;
            const outputIndex = input.index ?? 0;
            const existing = parentChildren[outputIndex];
            if (existing !== undefined && existing !== childTxid) {
                // Two distinct virtual txs claiming the same parent output would
                // silently corrupt the exit tree; refuse to build exit data in
                // that case rather than let last-write-wins pick one at random.
                throw new Error(
                    `Duplicate virtual spend for ${parentTxid}:${outputIndex}: ${existing} and ${childTxid}`
                );
            }
            parentChildren[outputIndex] = childTxid;
        }
    }

    return txids.map((txid, index) => ({
        txid,
        tx: txs[index],
        children: childrenByParent.get(txid) ?? {},
    }));
}

export async function buildExitDataForVtxo(
    vtxo: VirtualCoin,
    indexer: IndexerProvider
): Promise<ExitData> {
    const outpoint: Outpoint = { txid: vtxo.txid, vout: vtxo.vout };
    const { chain } = await indexer.getVtxoChain(outpoint);

    // Only TREE / ARK entries have virtual PSBTs that getVirtualTxs
    // will return. COMMITMENT entries are onchain and CHECKPOINT
    // entries are PSBT-less; including either would trip the length
    // check below and make sovereign-exit unavailable for checkpointed
    // VTXOs.
    const virtualTxids = chain
        .filter(
            (entry) =>
                entry.type === ChainTxType.TREE ||
                entry.type === ChainTxType.ARK
        )
        .map((entry) => entry.txid);

    const { txs } =
        virtualTxids.length > 0
            ? await indexer.getVirtualTxs(virtualTxids)
            : { txs: [] };

    if (txs.length !== virtualTxids.length) {
        throw new Error(
            `Virtual tx count mismatch while collecting exit data: expected ${virtualTxids.length}, got ${txs.length}`
        );
    }

    const virtualTxMap = Object.fromEntries(
        virtualTxids.map((txid, index) => [txid, txs[index]])
    );

    return collectExitData(
        vtxo,
        chain,
        virtualTxMap,
        buildTreeNodes(virtualTxids, txs)
    );
}

export async function syncExitData(
    vtxos: VirtualCoin[],
    indexer: IndexerProvider,
    repo: ExitDataRepository
): Promise<void> {
    // Build and save each VTXO independently so a single indexer miss
    // or malformed PSBT does not prevent the healthy VTXOs in the batch
    // from getting their exit data persisted.
    const results = await Promise.allSettled(
        vtxos.map(async (vtxo) => {
            const entry = await buildExitDataForVtxo(vtxo, indexer);
            await repo.saveExitData(entry);
        })
    );
    for (let i = 0; i < results.length; i++) {
        const result = results[i];
        if (result.status === "rejected") {
            const vtxo = vtxos[i];
            console.warn(
                `[ark-sdk] exit-data sync failed for ${vtxo.txid}:${vtxo.vout}:`,
                result.reason
            );
        }
    }
}
