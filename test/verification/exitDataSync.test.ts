import { describe, expect, it, vi } from "vitest";
import { base64 } from "@scure/base";
import type { IndexerProvider } from "../../src/providers/indexer";
import type { VirtualCoin } from "../../src/wallet";
import {
    buildExitDataForVtxo,
    syncExitData,
} from "../../src/verification/exitDataSync";
import { ExitDataStore } from "../../src/verification/exitDataRepository";
import { InMemoryStorageAdapter } from "../../src/storage/inMemory";

const newExitRepo = () => new ExitDataStore(new InMemoryStorageAdapter());
import { Transaction as ArkTransaction } from "../../src/utils/transaction";
import { randomPrivateKeyBytes } from "@scure/btc-signer/utils.js";
import { SingleKey } from "../../src/identity/singleKey";

describe("exitDataSync", () => {
    it("builds exit data for a single VTXO", async () => {
        const { psbt, txid } = await buildValidPsbt();
        const indexer = createMockIndexer(new Map([[txid, psbt]]));
        const vtxo = makeVtxo(txid);

        const result = await buildExitDataForVtxo(vtxo, indexer);

        expect(result.vtxoOutpoint.txid).toBe(vtxo.txid);
        expect(result.commitmentTxid).toBe("cc".repeat(32));
        expect(result.treeNodes).toHaveLength(1);
    });

    it("syncs built exit data into a repository", async () => {
        const { psbt, txid } = await buildValidPsbt();
        const indexer = createMockIndexer(new Map([[txid, psbt]]));
        const repo = newExitRepo();

        await syncExitData([makeVtxo(txid)], indexer, repo);

        expect(await repo.getExitData({ txid, vout: 0 })).not.toBeNull();
    });

    it("rejects a tampered PSBT whose computed txid does not match the indexer's claim", async () => {
        const { psbt: honestPsbt, txid: honestTxid } = await buildValidPsbt();
        const { psbt: forgedPsbt } = await buildValidPsbt();

        // Indexer returns a different PSBT under the claimed txid.
        const indexer = createMockIndexer(new Map([[honestTxid, forgedPsbt]]));
        const repo = newExitRepo();

        await expect(
            buildExitDataForVtxo(makeVtxo(honestTxid), indexer)
        ).rejects.toThrow(/integrity check failed/i);

        // syncExitData must catch the rejection instead of persisting bad data.
        await syncExitData([makeVtxo(honestTxid)], indexer, repo);
        expect(
            await repo.getExitData({ txid: honestTxid, vout: 0 })
        ).toBeNull();

        void honestPsbt;
    });
});

function makeVtxo(txid: string): VirtualCoin {
    return {
        txid,
        vout: 0,
        value: 10_000n,
        virtualStatus: {
            state: "confirmed",
            batchTxid: "cc".repeat(32),
            commitmentTxIds: ["cc".repeat(32)],
        },
    } as VirtualCoin;
}

function createMockIndexer(psbtsByTxid: Map<string, string>): IndexerProvider {
    return {
        getVtxoChain: vi.fn().mockImplementation(async (outpoint) => ({
            chain: [
                {
                    txid: "cc".repeat(32),
                    type: "INDEXER_CHAINED_TX_TYPE_COMMITMENT",
                    expiresAt: "",
                    spends: [],
                },
                {
                    txid: outpoint.txid,
                    type: "INDEXER_CHAINED_TX_TYPE_TREE",
                    expiresAt: "",
                    spends: ["cc".repeat(32)],
                },
            ],
        })),
        getVirtualTxs: vi.fn().mockImplementation(async (txids: string[]) => ({
            txs: txids.map((t) => {
                const psbt = psbtsByTxid.get(t);
                if (!psbt) throw new Error(`unknown txid: ${t}`);
                return psbt;
            }),
        })),
        getVtxoTree: vi.fn(),
        getVtxoTreeLeaves: vi.fn(),
        getBatchSweepTransactions: vi.fn(),
        getCommitmentTx: vi.fn(),
        getCommitmentTxConnectors: vi.fn(),
        getCommitmentTxForfeitTxs: vi.fn(),
        getSubscription: vi.fn(),
        getVtxos: vi.fn(),
        getAssetDetails: vi.fn(),
        subscribeForScripts: vi.fn(),
        unsubscribeForScripts: vi.fn(),
    } as IndexerProvider;
}

async function buildValidPsbt(): Promise<{ psbt: string; txid: string }> {
    const tx = new ArkTransaction();
    const inputKey = await SingleKey.fromPrivateKey(
        randomPrivateKeyBytes()
    ).xOnlyPublicKey();
    const outputKey = await SingleKey.fromPrivateKey(
        randomPrivateKeyBytes()
    ).xOnlyPublicKey();
    tx.addOutput({
        script: taprootOutputScript(outputKey),
        amount: 10_000n,
    });
    tx.addInput({
        txid: new Uint8Array(32).fill(0x11),
        index: 0,
        witnessUtxo: {
            script: taprootOutputScript(inputKey),
            amount: 10_000n,
        },
        tapKeySig: new Uint8Array(64).fill(0x22),
    });

    return { psbt: base64.encode(tx.toPSBT()), txid: tx.id };
}

function taprootOutputScript(xOnlyKey: Uint8Array): Uint8Array {
    const script = new Uint8Array(34);
    script[0] = 0x51;
    script[1] = 0x20;
    script.set(xOnlyKey, 2);
    return script;
}
