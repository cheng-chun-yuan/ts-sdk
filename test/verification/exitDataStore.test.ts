import { describe, it, expect } from "vitest";
import {
    collectExitData,
    validateExitData,
} from "../../src/verification/exitDataStore";
import type { ExitData } from "../../src/verification/exitDataStore";
import type { VirtualCoin } from "../../src/wallet";
import type { ChainTx } from "../../src/providers/indexer";

describe("collectExitData", () => {
    it("should collect all required data from a VTXO chain", () => {
        const vtxo = makeVtxo("aa".repeat(32));
        const chain = makeChain("cc".repeat(32));
        const virtualTxs = { ["bb".repeat(32)]: "base64psbt" };
        const treeNodes = [
            { txid: "bb".repeat(32), tx: "base64psbt", children: {} },
        ];

        const exitData = collectExitData(vtxo, chain, virtualTxs, treeNodes);

        expect(exitData.vtxoOutpoint.txid).toBe(vtxo.txid);
        expect(exitData.commitmentTxid).toBe("cc".repeat(32));
        expect(exitData.chain).toHaveLength(chain.length);
        expect(Object.keys(exitData.virtualTxs)).toHaveLength(1);
        expect(exitData.treeNodes).toHaveLength(1);
        expect(exitData.storedAt).toBeGreaterThan(0);
    });

    it("should include all chain entries from leaf to commitment", () => {
        const vtxo = makeVtxo("aa".repeat(32));
        const chain: ChainTx[] = [
            {
                txid: "cc".repeat(32),
                type: "INDEXER_CHAINED_TX_TYPE_COMMITMENT" as any,
                expiresAt: "",
                spends: [],
            },
            {
                txid: "bb".repeat(32),
                type: "INDEXER_CHAINED_TX_TYPE_TREE" as any,
                expiresAt: "",
                spends: ["cc".repeat(32)],
            },
        ];
        const virtualTxs = { ["bb".repeat(32)]: "psbt1" };
        const treeNodes = [
            { txid: "bb".repeat(32), tx: "psbt1", children: {} },
        ];

        const exitData = collectExitData(vtxo, chain, virtualTxs, treeNodes);

        expect(exitData.chain).toHaveLength(2);
    });
});

describe("validateExitData", () => {
    it("should pass for complete exit data", () => {
        const data = makeExitData();
        const result = validateExitData(data);

        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
    });

    it("should fail when virtual tx is missing for a chain entry", () => {
        const data = makeExitData();
        // Remove the virtual tx for a tree entry
        data.virtualTxs = {};

        const result = validateExitData(data);

        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => /missing.*virtual/i.test(e))).toBe(
            true
        );
    });

    it("should fail when commitment txid is empty", () => {
        const data = makeExitData();
        data.commitmentTxid = "";

        const result = validateExitData(data);

        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => /commitment/i.test(e))).toBe(true);
    });

    it("should fail when chain is empty", () => {
        const data = makeExitData();
        data.chain = [];

        const result = validateExitData(data);

        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => /chain.*empty/i.test(e))).toBe(true);
    });

    it("should pass when all tree entries have virtual txs", () => {
        const data = makeExitData();
        // Ensure all tree entries are covered
        const result = validateExitData(data);
        expect(result.valid).toBe(true);
    });

    it("should report multiple errors at once", () => {
        const data = makeExitData();
        data.commitmentTxid = "";
        data.chain = [];

        const result = validateExitData(data);
        expect(result.valid).toBe(false);
        expect(result.errors.length).toBeGreaterThanOrEqual(2);
    });
});

// ============================================================
// Test helpers
// ============================================================

function makeVtxo(txid: string): VirtualCoin {
    return {
        txid,
        vout: 0,
        value: 10_000n,
        virtualStatus: {
            state: "confirmed",
            batchTxid: "",
            commitmentTxIds: ["cc".repeat(32)],
        },
    } as VirtualCoin;
}

function makeChain(commitmentTxid: string): ChainTx[] {
    return [
        {
            txid: commitmentTxid,
            type: "INDEXER_CHAINED_TX_TYPE_COMMITMENT" as any,
            expiresAt: "",
            spends: [],
        },
        {
            txid: "bb".repeat(32),
            type: "INDEXER_CHAINED_TX_TYPE_TREE" as any,
            expiresAt: "",
            spends: [commitmentTxid],
        },
    ];
}

function makeExitData(vtxoTxid?: string): ExitData {
    const txid = vtxoTxid ?? "aa".repeat(32);
    return {
        vtxoOutpoint: { txid, vout: 0 },
        commitmentTxid: "cc".repeat(32),
        chain: makeChain("cc".repeat(32)),
        virtualTxs: { ["bb".repeat(32)]: "base64psbt" },
        treeNodes: [{ txid: "bb".repeat(32), tx: "base64psbt", children: {} }],
        storedAt: Date.now(),
    };
}
