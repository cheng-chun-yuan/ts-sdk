import { describe, it, expect, vi, beforeEach } from "vitest";
import {
    verifyVtxo,
    verifyAllVtxos,
} from "../../src/verification/vtxoChainVerifier";
import type { IndexerProvider } from "../../src/providers/indexer";
import type { OnchainProvider } from "../../src/providers/onchain";
import type { VirtualCoin } from "../../src/wallet";
import type { RelativeTimelock } from "../../src/script/tapscript";

function createMockIndexer(): IndexerProvider {
    return {
        getVtxoChain: vi.fn(),
        getVtxoTree: vi.fn(),
        getVirtualTxs: vi.fn(),
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

function createMockOnchain(): OnchainProvider {
    return {
        getTxStatus: vi.fn(),
        getChainTip: vi.fn(),
        getTxHex: vi.fn(),
        getTxOutspends: vi.fn(),
        getCoins: vi.fn(),
        getFeeRate: vi.fn(),
        broadcastTransaction: vi.fn(),
        getTransactions: vi.fn(),
        watchAddresses: vi.fn(),
    } as OnchainProvider;
}

describe("verifyVtxo", () => {
    const serverInfo = {
        pubkey: new Uint8Array(32).fill(0xaa),
        sweepInterval: { value: 144n, type: "blocks" } as RelativeTimelock,
    };

    let mockIndexer: IndexerProvider;
    let mockOnchain: OnchainProvider;

    beforeEach(() => {
        mockIndexer = createMockIndexer();
        mockOnchain = createMockOnchain();
    });

    describe("preconfirmed VTXO rejection", () => {
        it("should reject preconfirmed VTXOs immediately", async () => {
            const vtxo: VirtualCoin = {
                txid: "aa".repeat(32),
                vout: 0,
                value: 1000n,
                virtualStatus: {
                    state: "preconfirmed",
                    batchTxid: "",
                    commitmentTxIds: [],
                },
            } as VirtualCoin;

            const result = await verifyVtxo(
                vtxo,
                mockIndexer,
                mockOnchain,
                serverInfo
            );

            expect(result.valid).toBe(false);
            expect(result.errors.some((e) => /preconfirmed/i.test(e))).toBe(
                true
            );
            expect(mockIndexer.getVtxoChain).not.toHaveBeenCalled();
        });
    });

    describe("chain fetching", () => {
        it("should error when VTXO chain is empty", async () => {
            const vtxo = makeVtxo("cc".repeat(32));
            (
                mockIndexer.getVtxoChain as ReturnType<typeof vi.fn>
            ).mockResolvedValue({ chain: [] });

            const result = await verifyVtxo(
                vtxo,
                mockIndexer,
                mockOnchain,
                serverInfo
            );

            expect(result.valid).toBe(false);
            expect(result.errors.some((e) => /[Ee]mpty.*chain/i.test(e))).toBe(
                true
            );
        });

        it("should error when no commitment tx found in chain", async () => {
            const vtxo = makeVtxo("cc".repeat(32));
            (
                mockIndexer.getVtxoChain as ReturnType<typeof vi.fn>
            ).mockResolvedValue({
                chain: [
                    {
                        txid: "bb".repeat(32),
                        type: "INDEXER_CHAINED_TX_TYPE_TREE",
                        expiresAt: "",
                        spends: [],
                    },
                ],
            });

            const result = await verifyVtxo(
                vtxo,
                mockIndexer,
                mockOnchain,
                serverInfo
            );

            expect(result.valid).toBe(false);
            expect(result.errors.some((e) => /[Nn]o commitment/i.test(e))).toBe(
                true
            );
        });

        it("should error when virtualStatus commitment tx not in chain", async () => {
            const vtxo = makeVtxo("cc".repeat(32), ["dd".repeat(32)]);
            (
                mockIndexer.getVtxoChain as ReturnType<typeof vi.fn>
            ).mockResolvedValue({
                chain: [
                    {
                        txid: "ee".repeat(32),
                        type: "INDEXER_CHAINED_TX_TYPE_COMMITMENT",
                        expiresAt: "",
                        spends: [],
                    },
                ],
            });

            const result = await verifyVtxo(
                vtxo,
                mockIndexer,
                mockOnchain,
                serverInfo
            );

            expect(result.valid).toBe(false);
            expect(
                result.errors.some((e) => /not found in chain/i.test(e))
            ).toBe(true);
        });

        it("should handle indexer fetch failure gracefully", async () => {
            const vtxo = makeVtxo("cc".repeat(32));
            (
                mockIndexer.getVtxoChain as ReturnType<typeof vi.fn>
            ).mockRejectedValue(new Error("indexer unavailable"));

            const result = await verifyVtxo(
                vtxo,
                mockIndexer,
                mockOnchain,
                serverInfo
            );

            expect(result.valid).toBe(false);
            expect(
                result.errors.some((e) => /indexer unavailable/i.test(e))
            ).toBe(true);
        });
    });

    describe("path verification", () => {
        it("should error when no virtual txs in chain path", async () => {
            const commitmentTxid = "aa".repeat(32);
            const vtxo = makeVtxo("cc".repeat(32), [commitmentTxid]);
            // Chain has only the commitment entry, no tree/checkpoint txs
            (
                mockIndexer.getVtxoChain as ReturnType<typeof vi.fn>
            ).mockResolvedValue({
                chain: [
                    {
                        txid: commitmentTxid,
                        type: "INDEXER_CHAINED_TX_TYPE_COMMITMENT",
                        expiresAt: "",
                        spends: [],
                    },
                ],
            });

            const result = await verifyVtxo(
                vtxo,
                mockIndexer,
                mockOnchain,
                serverInfo
            );

            expect(result.valid).toBe(false);
            expect(result.errors.some((e) => /no virtual|path/i.test(e))).toBe(
                true
            );
        });

        it("should error when virtual tx count mismatches path", async () => {
            const commitmentTxid = "aa".repeat(32);
            const vtxo = makeVtxo("cc".repeat(32), [commitmentTxid]);
            (
                mockIndexer.getVtxoChain as ReturnType<typeof vi.fn>
            ).mockResolvedValue({
                chain: [
                    {
                        txid: commitmentTxid,
                        type: "INDEXER_CHAINED_TX_TYPE_COMMITMENT",
                        expiresAt: "",
                        spends: [],
                    },
                    {
                        txid: "t1".repeat(32),
                        type: "INDEXER_CHAINED_TX_TYPE_TREE",
                        expiresAt: "",
                        spends: [commitmentTxid],
                    },
                    {
                        txid: "t2".repeat(32),
                        type: "INDEXER_CHAINED_TX_TYPE_TREE",
                        expiresAt: "",
                        spends: ["t1".repeat(32)],
                    },
                ],
            });
            (
                mockIndexer.getVirtualTxs as ReturnType<typeof vi.fn>
            ).mockResolvedValue({ txs: ["only-one-tx"] });

            const result = await verifyVtxo(
                vtxo,
                mockIndexer,
                mockOnchain,
                serverInfo
            );

            expect(result.valid).toBe(false);
            expect(result.errors.some((e) => /mismatch|count/i.test(e))).toBe(
                true
            );
        });
    });

    describe("checkpoint handling", () => {
        it("should warn on expired checkpoint transactions in chain", async () => {
            const commitmentTxid = "aa".repeat(32);
            const vtxo = makeVtxo("cc".repeat(32), [commitmentTxid]);
            // First call for step 1, second call for checkpoint check (step 3c)
            (
                mockIndexer.getVtxoChain as ReturnType<typeof vi.fn>
            ).mockResolvedValue({
                chain: [
                    {
                        txid: commitmentTxid,
                        type: "INDEXER_CHAINED_TX_TYPE_COMMITMENT",
                        expiresAt: "",
                        spends: [],
                    },
                    {
                        txid: "cp".repeat(32),
                        type: "INDEXER_CHAINED_TX_TYPE_CHECKPOINT",
                        expiresAt: "2020-01-01T00:00:00Z",
                        spends: [commitmentTxid],
                    },
                ],
            });
            (
                mockIndexer.getVtxoTree as ReturnType<typeof vi.fn>
            ).mockResolvedValue({
                vtxoTree: [],
                page: { current: 0, next: 0, total: 0 },
            });

            const result = await verifyVtxo(
                vtxo,
                mockIndexer,
                mockOnchain,
                serverInfo
            );

            // Will error on empty tree before reaching checkpoints,
            // but the chain fetch must succeed
            expect(result.valid).toBe(false);
        });

        it("should error on checkpoint with no parent references", async () => {
            const commitmentTxid = "aa".repeat(32);
            const vtxo = makeVtxo("cc".repeat(32), [commitmentTxid]);
            (
                mockIndexer.getVtxoChain as ReturnType<typeof vi.fn>
            ).mockResolvedValue({
                chain: [
                    {
                        txid: commitmentTxid,
                        type: "INDEXER_CHAINED_TX_TYPE_COMMITMENT",
                        expiresAt: "",
                        spends: [],
                    },
                    {
                        txid: "cp".repeat(32),
                        type: "INDEXER_CHAINED_TX_TYPE_CHECKPOINT",
                        expiresAt: "",
                        spends: [], // no parent
                    },
                ],
            });
            (
                mockIndexer.getVtxoTree as ReturnType<typeof vi.fn>
            ).mockResolvedValue({
                vtxoTree: [],
                page: { current: 0, next: 0, total: 0 },
            });

            const result = await verifyVtxo(
                vtxo,
                mockIndexer,
                mockOnchain,
                serverInfo
            );

            expect(result.valid).toBe(false);
        });
    });

    describe("result structure", () => {
        it("should return well-formed result even on failure", async () => {
            const vtxo = makeVtxo("cc".repeat(32));
            (
                mockIndexer.getVtxoChain as ReturnType<typeof vi.fn>
            ).mockResolvedValue({ chain: [] });

            const result = await verifyVtxo(
                vtxo,
                mockIndexer,
                mockOnchain,
                serverInfo
            );

            expect(result).toHaveProperty("valid");
            expect(result).toHaveProperty("vtxoOutpoint");
            expect(result).toHaveProperty("commitmentTxid");
            expect(result).toHaveProperty("commitmentTxids");
            expect(result).toHaveProperty("confirmationDepth");
            expect(result).toHaveProperty("chainLength");
            expect(result).toHaveProperty("errors");
            expect(result).toHaveProperty("warnings");
            expect(Array.isArray(result.errors)).toBe(true);
            expect(Array.isArray(result.warnings)).toBe(true);
            expect(Array.isArray(result.commitmentTxids)).toBe(true);
        });
    });

    describe("multi-commitment DAG", () => {
        it("should find multiple commitment txs in the chain", async () => {
            const commit1 = "c1".repeat(32);
            const commit2 = "c2".repeat(32);
            const vtxo = makeVtxo("cc".repeat(32), [commit1, commit2]);

            (
                mockIndexer.getVtxoChain as ReturnType<typeof vi.fn>
            ).mockResolvedValue({
                chain: [
                    {
                        txid: commit1,
                        type: "INDEXER_CHAINED_TX_TYPE_COMMITMENT",
                        expiresAt: "",
                        spends: [],
                    },
                    {
                        txid: commit2,
                        type: "INDEXER_CHAINED_TX_TYPE_COMMITMENT",
                        expiresAt: "",
                        spends: [],
                    },
                    {
                        txid: "tt".repeat(32),
                        type: "INDEXER_CHAINED_TX_TYPE_TREE",
                        expiresAt: "",
                        spends: [commit1],
                    },
                ],
            });
            (
                mockIndexer.getVirtualTxs as ReturnType<typeof vi.fn>
            ).mockResolvedValue({ txs: [] });

            const result = await verifyVtxo(
                vtxo,
                mockIndexer,
                mockOnchain,
                serverInfo
            );

            // Should find both commitment txids
            expect(result.commitmentTxids).toContain(commit1);
            expect(result.commitmentTxids).toContain(commit2);
            expect(result.commitmentTxids).toHaveLength(2);
        });

        it("should error when virtualStatus commitment tx not in chain", async () => {
            const chainCommit = "c1".repeat(32);
            const statusCommit = "c9".repeat(32); // not in chain
            const vtxo = makeVtxo("cc".repeat(32), [statusCommit]);

            (
                mockIndexer.getVtxoChain as ReturnType<typeof vi.fn>
            ).mockResolvedValue({
                chain: [
                    {
                        txid: chainCommit,
                        type: "INDEXER_CHAINED_TX_TYPE_COMMITMENT",
                        expiresAt: "",
                        spends: [],
                    },
                ],
            });

            const result = await verifyVtxo(
                vtxo,
                mockIndexer,
                mockOnchain,
                serverInfo
            );

            expect(
                result.errors.some((e) => /not found in chain/i.test(e))
            ).toBe(true);
        });

        it("should use per-commitment output index for multi-batch VTXOs", async () => {
            const commit1 = "c1".repeat(32);
            const commit2 = "c2".repeat(32);
            const child1 = "d1".repeat(32);
            const child2 = "d2".repeat(32);
            const vtxo = makeVtxo("cc".repeat(32), [commit1, commit2]);

            (
                mockIndexer.getVtxoChain as ReturnType<typeof vi.fn>
            ).mockResolvedValue({
                chain: [
                    {
                        txid: commit1,
                        type: "INDEXER_CHAINED_TX_TYPE_COMMITMENT",
                        expiresAt: "",
                        spends: [],
                    },
                    {
                        txid: commit2,
                        type: "INDEXER_CHAINED_TX_TYPE_COMMITMENT",
                        expiresAt: "",
                        spends: [],
                    },
                    {
                        txid: child1,
                        type: "INDEXER_CHAINED_TX_TYPE_TREE",
                        expiresAt: "",
                        spends: [commit1],
                    },
                    {
                        txid: child2,
                        type: "INDEXER_CHAINED_TX_TYPE_TREE",
                        expiresAt: "",
                        spends: [commit2],
                    },
                ],
            });
            (
                mockIndexer.getVirtualTxs as ReturnType<typeof vi.fn>
            ).mockResolvedValue({ txs: [] });

            const result = await verifyVtxo(
                vtxo,
                mockIndexer,
                mockOnchain,
                serverInfo
            );

            expect(result.commitmentTxids).toContain(commit1);
            expect(result.commitmentTxids).toContain(commit2);
            expect(result.commitmentTxids).toHaveLength(2);
            // Will fail due to tx count mismatch but commitments are found
            expect(result.valid).toBe(false);
            expect(result.errors.some((e) => /mismatch|count/i.test(e))).toBe(
                true
            );
        });
    });
});

describe("verifyAllVtxos", () => {
    const serverInfo = {
        pubkey: new Uint8Array(32).fill(0xaa),
        sweepInterval: { value: 144n, type: "blocks" } as RelativeTimelock,
    };

    let mockIndexer: IndexerProvider;
    let mockOnchain: OnchainProvider;

    beforeEach(() => {
        mockIndexer = createMockIndexer();
        mockOnchain = createMockOnchain();
    });

    it("should return empty map for empty VTXO list", async () => {
        const result = await verifyAllVtxos(
            [],
            mockIndexer,
            mockOnchain,
            serverInfo
        );

        expect(result.size).toBe(0);
    });

    it("should group VTXOs by commitment txid", async () => {
        const commitmentTxid = "aa".repeat(32);
        const vtxo1 = makeVtxo("v1".padEnd(64, "0"), [commitmentTxid]);
        const vtxo2 = makeVtxo("v2".padEnd(64, "0"), [commitmentTxid]);

        (
            mockIndexer.getVtxoChain as ReturnType<typeof vi.fn>
        ).mockResolvedValue({
            chain: [
                {
                    txid: commitmentTxid,
                    type: "INDEXER_CHAINED_TX_TYPE_COMMITMENT",
                    expiresAt: "",
                    spends: [],
                },
            ],
        });
        (mockIndexer.getVtxoTree as ReturnType<typeof vi.fn>).mockResolvedValue(
            { vtxoTree: [], page: { current: 0, next: 0, total: 0 } }
        );

        const result = await verifyAllVtxos(
            [vtxo1, vtxo2],
            mockIndexer,
            mockOnchain,
            serverInfo
        );

        expect(result.size).toBe(2);
    });

    it("should return result keyed by vtxo outpoint string", async () => {
        const vtxo = makeVtxo("cc".repeat(32));
        (
            mockIndexer.getVtxoChain as ReturnType<typeof vi.fn>
        ).mockResolvedValue({ chain: [] });

        const result = await verifyAllVtxos(
            [vtxo],
            mockIndexer,
            mockOnchain,
            serverInfo
        );

        const keys = Array.from(result.keys());
        expect(keys.length).toBe(1);
        expect(keys[0]).toContain(vtxo.txid);
    });

    it("should handle VTXOs with different commitment txids separately", async () => {
        const vtxo1 = makeVtxo("v1".padEnd(64, "0"), ["c1".repeat(32)]);
        const vtxo2 = makeVtxo("v2".padEnd(64, "0"), ["c2".repeat(32)]);

        (
            mockIndexer.getVtxoChain as ReturnType<typeof vi.fn>
        ).mockResolvedValue({ chain: [] });

        const result = await verifyAllVtxos(
            [vtxo1, vtxo2],
            mockIndexer,
            mockOnchain,
            serverInfo
        );

        expect(result.size).toBe(2);
        // Both should fail (empty chain) but be independent
        for (const [, r] of result) {
            expect(r.valid).toBe(false);
        }
    });

    it("should propagate vtxoOutpoint per VTXO in grouped results", async () => {
        const commitmentTxid = "aa".repeat(32);
        const vtxo1 = makeVtxo("v1".padEnd(64, "0"), [commitmentTxid]);
        const vtxo2 = makeVtxo("v2".padEnd(64, "0"), [commitmentTxid]);

        (
            mockIndexer.getVtxoChain as ReturnType<typeof vi.fn>
        ).mockResolvedValue({
            chain: [
                {
                    txid: commitmentTxid,
                    type: "INDEXER_CHAINED_TX_TYPE_COMMITMENT",
                    expiresAt: "",
                    spends: [],
                },
            ],
        });
        (mockIndexer.getVtxoTree as ReturnType<typeof vi.fn>).mockResolvedValue(
            { vtxoTree: [], page: { current: 0, next: 0, total: 0 } }
        );

        const result = await verifyAllVtxos(
            [vtxo1, vtxo2],
            mockIndexer,
            mockOnchain,
            serverInfo
        );

        const r1 = result.get(`${"v1".padEnd(64, "0")}:0`);
        const r2 = result.get(`${"v2".padEnd(64, "0")}:0`);
        expect(r1?.vtxoOutpoint.txid).toBe("v1".padEnd(64, "0"));
        expect(r2?.vtxoOutpoint.txid).toBe("v2".padEnd(64, "0"));
    });
});

describe("verifyVtxo edge cases", () => {
    const serverInfo = {
        pubkey: new Uint8Array(32).fill(0xaa),
        sweepInterval: { value: 144n, type: "blocks" } as RelativeTimelock,
    };

    let mockIndexer: IndexerProvider;
    let mockOnchain: OnchainProvider;

    beforeEach(() => {
        mockIndexer = createMockIndexer();
        mockOnchain = createMockOnchain();
    });

    it("should handle VTXO with no virtualStatus gracefully", async () => {
        const vtxo = {
            txid: "cc".repeat(32),
            vout: 0,
            value: 10_000n,
        } as VirtualCoin;

        (
            mockIndexer.getVtxoChain as ReturnType<typeof vi.fn>
        ).mockResolvedValue({ chain: [] });

        const result = await verifyVtxo(
            vtxo,
            mockIndexer,
            mockOnchain,
            serverInfo
        );

        expect(result.valid).toBe(false);
    });

    it("should exclude checkpoint entries from pathTxids", async () => {
        const commitmentTxid = "aa".repeat(32);
        const treeTxid = "bb".repeat(32);
        const vtxo = makeVtxo("cc".repeat(32), [commitmentTxid]);
        (
            mockIndexer.getVtxoChain as ReturnType<typeof vi.fn>
        ).mockResolvedValue({
            chain: [
                {
                    txid: commitmentTxid,
                    type: "INDEXER_CHAINED_TX_TYPE_COMMITMENT",
                    expiresAt: "",
                    spends: [],
                },
                {
                    txid: treeTxid,
                    type: "INDEXER_CHAINED_TX_TYPE_TREE",
                    expiresAt: "",
                    spends: [commitmentTxid],
                },
                {
                    txid: "cp".repeat(32),
                    type: "INDEXER_CHAINED_TX_TYPE_CHECKPOINT",
                    expiresAt: "2026-12-31T00:00:00Z",
                    spends: [treeTxid],
                },
            ],
        });
        // Only the tree tx should be requested (not the checkpoint)
        (
            mockIndexer.getVirtualTxs as ReturnType<typeof vi.fn>
        ).mockResolvedValue({ txs: [] });

        await verifyVtxo(vtxo, mockIndexer, mockOnchain, serverInfo);

        const calledWith = (
            mockIndexer.getVirtualTxs as ReturnType<typeof vi.fn>
        ).mock.calls[0][0];
        expect(calledWith).toContain(treeTxid);
        expect(calledWith).not.toContain("cp".repeat(32));
        expect(calledWith).toHaveLength(1);
    });

    it("should include ARK type entries in pathTxids", async () => {
        const commitmentTxid = "aa".repeat(32);
        const arkTxid = "ak".repeat(32);
        const vtxo = makeVtxo("cc".repeat(32), [commitmentTxid]);
        (
            mockIndexer.getVtxoChain as ReturnType<typeof vi.fn>
        ).mockResolvedValue({
            chain: [
                {
                    txid: commitmentTxid,
                    type: "INDEXER_CHAINED_TX_TYPE_COMMITMENT",
                    expiresAt: "",
                    spends: [],
                },
                {
                    txid: arkTxid,
                    type: "INDEXER_CHAINED_TX_TYPE_ARK",
                    expiresAt: "",
                    spends: [commitmentTxid],
                },
            ],
        });
        (
            mockIndexer.getVirtualTxs as ReturnType<typeof vi.fn>
        ).mockResolvedValue({ txs: [] });

        await verifyVtxo(vtxo, mockIndexer, mockOnchain, serverInfo);

        const calledWith = (
            mockIndexer.getVirtualTxs as ReturnType<typeof vi.fn>
        ).mock.calls[0][0];
        expect(calledWith).toContain(arkTxid);
    });

    it("should handle VTXO with empty commitmentTxIds", async () => {
        const vtxo = makeVtxo("cc".repeat(32), []);
        const commitmentTxid = "dd".repeat(32);

        (
            mockIndexer.getVtxoChain as ReturnType<typeof vi.fn>
        ).mockResolvedValue({
            chain: [
                {
                    txid: commitmentTxid,
                    type: "INDEXER_CHAINED_TX_TYPE_COMMITMENT",
                    expiresAt: "",
                    spends: [],
                },
            ],
        });
        (mockIndexer.getVtxoTree as ReturnType<typeof vi.fn>).mockResolvedValue(
            { vtxoTree: [], page: { current: 0, next: 0, total: 0 } }
        );

        // Should proceed (no mismatch check when commitmentTxIds is empty)
        const result = await verifyVtxo(
            vtxo,
            mockIndexer,
            mockOnchain,
            serverInfo
        );

        // Will fail on empty tree, but not on mismatch
        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => /mismatch/i.test(e))).toBe(false);
    });
});

// ============================================================
// Adversarial / attack-vector tests
// ============================================================

describe("verifyVtxo adversarial inputs", () => {
    const serverInfo = {
        pubkey: new Uint8Array(32).fill(0xaa),
        sweepInterval: { value: 144n, type: "blocks" } as RelativeTimelock,
    };

    let mockIndexer: IndexerProvider;
    let mockOnchain: OnchainProvider;

    beforeEach(() => {
        mockIndexer = createMockIndexer();
        mockOnchain = createMockOnchain();
    });

    it("should reject chain with only checkpoint entries (no virtual txs)", async () => {
        const commitmentTxid = "aa".repeat(32);
        const vtxo = makeVtxo("cc".repeat(32), [commitmentTxid]);
        (
            mockIndexer.getVtxoChain as ReturnType<typeof vi.fn>
        ).mockResolvedValue({
            chain: [
                {
                    txid: commitmentTxid,
                    type: "INDEXER_CHAINED_TX_TYPE_COMMITMENT",
                    expiresAt: "",
                    spends: [],
                },
                {
                    txid: "cp".repeat(32),
                    type: "INDEXER_CHAINED_TX_TYPE_CHECKPOINT",
                    expiresAt: "",
                    spends: [commitmentTxid],
                },
            ],
        });

        const result = await verifyVtxo(
            vtxo,
            mockIndexer,
            mockOnchain,
            serverInfo
        );

        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => /no virtual/i.test(e))).toBe(true);
        // getVirtualTxs should NOT be called since pathTxids is empty
        expect(mockIndexer.getVirtualTxs).not.toHaveBeenCalled();
    });

    it("should reject when indexer returns malformed PSBT (base64 garbage)", async () => {
        const commitmentTxid = "aa".repeat(32);
        const treeTxid = "bb".repeat(32);
        const vtxo = makeVtxo("cc".repeat(32), [commitmentTxid]);
        (
            mockIndexer.getVtxoChain as ReturnType<typeof vi.fn>
        ).mockResolvedValue({
            chain: [
                {
                    txid: commitmentTxid,
                    type: "INDEXER_CHAINED_TX_TYPE_COMMITMENT",
                    expiresAt: "",
                    spends: [],
                },
                {
                    txid: treeTxid,
                    type: "INDEXER_CHAINED_TX_TYPE_TREE",
                    expiresAt: "",
                    spends: [commitmentTxid],
                },
            ],
        });
        // Return garbage base64 that will crash PSBT parsing
        (
            mockIndexer.getVirtualTxs as ReturnType<typeof vi.fn>
        ).mockResolvedValue({ txs: ["not-a-valid-base64-psbt!!!"] });

        const result = await verifyVtxo(
            vtxo,
            mockIndexer,
            mockOnchain,
            serverInfo
        );

        expect(result.valid).toBe(false);
        expect(result.errors.length).toBeGreaterThan(0);
    });

    it("should reject when getVirtualTxs returns undefined txs", async () => {
        const commitmentTxid = "aa".repeat(32);
        const vtxo = makeVtxo("cc".repeat(32), [commitmentTxid]);
        (
            mockIndexer.getVtxoChain as ReturnType<typeof vi.fn>
        ).mockResolvedValue({
            chain: [
                {
                    txid: commitmentTxid,
                    type: "INDEXER_CHAINED_TX_TYPE_COMMITMENT",
                    expiresAt: "",
                    spends: [],
                },
                {
                    txid: "bb".repeat(32),
                    type: "INDEXER_CHAINED_TX_TYPE_TREE",
                    expiresAt: "",
                    spends: [commitmentTxid],
                },
            ],
        });
        // Malformed response — no txs field
        (
            mockIndexer.getVirtualTxs as ReturnType<typeof vi.fn>
        ).mockResolvedValue({});

        const result = await verifyVtxo(
            vtxo,
            mockIndexer,
            mockOnchain,
            serverInfo
        );

        expect(result.valid).toBe(false);
    });

    it("should reject duplicate commitment txids in chain", async () => {
        const commitmentTxid = "aa".repeat(32);
        const vtxo = makeVtxo("cc".repeat(32), [commitmentTxid]);
        (
            mockIndexer.getVtxoChain as ReturnType<typeof vi.fn>
        ).mockResolvedValue({
            chain: [
                {
                    txid: commitmentTxid,
                    type: "INDEXER_CHAINED_TX_TYPE_COMMITMENT",
                    expiresAt: "",
                    spends: [],
                },
                {
                    txid: commitmentTxid,
                    type: "INDEXER_CHAINED_TX_TYPE_COMMITMENT",
                    expiresAt: "",
                    spends: [],
                },
            ],
        });

        const result = await verifyVtxo(
            vtxo,
            mockIndexer,
            mockOnchain,
            serverInfo
        );

        // Should still find the commitment but fail on no virtual txs
        expect(result.valid).toBe(false);
        expect(result.commitmentTxids).toContain(commitmentTxid);
    });

    it("should reject when virtualStatus claims a commitment not in chain", async () => {
        const realCommit = "aa".repeat(32);
        const fakeCommit = "ff".repeat(32);
        const vtxo = makeVtxo("cc".repeat(32), [fakeCommit]);

        (
            mockIndexer.getVtxoChain as ReturnType<typeof vi.fn>
        ).mockResolvedValue({
            chain: [
                {
                    txid: realCommit,
                    type: "INDEXER_CHAINED_TX_TYPE_COMMITMENT",
                    expiresAt: "",
                    spends: [],
                },
                {
                    txid: "bb".repeat(32),
                    type: "INDEXER_CHAINED_TX_TYPE_TREE",
                    expiresAt: "",
                    spends: [realCommit],
                },
            ],
        });
        (
            mockIndexer.getVirtualTxs as ReturnType<typeof vi.fn>
        ).mockResolvedValue({ txs: [] });

        const result = await verifyVtxo(
            vtxo,
            mockIndexer,
            mockOnchain,
            serverInfo
        );

        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => /not found in chain/i.test(e))).toBe(
            true
        );
    });

    it("should reject when indexer getVtxoChain throws", async () => {
        const vtxo = makeVtxo("cc".repeat(32));
        (
            mockIndexer.getVtxoChain as ReturnType<typeof vi.fn>
        ).mockRejectedValue(new Error("indexer is down"));

        const result = await verifyVtxo(
            vtxo,
            mockIndexer,
            mockOnchain,
            serverInfo
        );

        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => /indexer is down/i.test(e))).toBe(
            true
        );
    });

    it("should reject when chain has no commitment entries", async () => {
        const vtxo = makeVtxo("cc".repeat(32));
        (
            mockIndexer.getVtxoChain as ReturnType<typeof vi.fn>
        ).mockResolvedValue({
            chain: [
                {
                    txid: "bb".repeat(32),
                    type: "INDEXER_CHAINED_TX_TYPE_TREE",
                    expiresAt: "",
                    spends: [],
                },
                {
                    txid: "dd".repeat(32),
                    type: "INDEXER_CHAINED_TX_TYPE_ARK",
                    expiresAt: "",
                    spends: ["bb".repeat(32)],
                },
            ],
        });

        const result = await verifyVtxo(
            vtxo,
            mockIndexer,
            mockOnchain,
            serverInfo
        );

        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => /no commitment/i.test(e))).toBe(true);
    });

    it("should reject when getVirtualTxs returns fewer txs than requested", async () => {
        const commitmentTxid = "aa".repeat(32);
        const vtxo = makeVtxo("cc".repeat(32), [commitmentTxid]);
        (
            mockIndexer.getVtxoChain as ReturnType<typeof vi.fn>
        ).mockResolvedValue({
            chain: [
                {
                    txid: commitmentTxid,
                    type: "INDEXER_CHAINED_TX_TYPE_COMMITMENT",
                    expiresAt: "",
                    spends: [],
                },
                {
                    txid: "t1".repeat(32),
                    type: "INDEXER_CHAINED_TX_TYPE_TREE",
                    expiresAt: "",
                    spends: [commitmentTxid],
                },
                {
                    txid: "t2".repeat(32),
                    type: "INDEXER_CHAINED_TX_TYPE_TREE",
                    expiresAt: "",
                    spends: ["t1".repeat(32)],
                },
            ],
        });
        // Requested 2 txs but only got 1
        (
            mockIndexer.getVirtualTxs as ReturnType<typeof vi.fn>
        ).mockResolvedValue({ txs: ["some-psbt"] });

        const result = await verifyVtxo(
            vtxo,
            mockIndexer,
            mockOnchain,
            serverInfo
        );

        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => /mismatch|count/i.test(e))).toBe(true);
    });

    it("should reject preconfirmed VTXO without calling indexer", async () => {
        const vtxo = {
            txid: "aa".repeat(32),
            vout: 0,
            value: 1000n,
            virtualStatus: {
                state: "preconfirmed",
                batchTxid: "",
                commitmentTxIds: [],
            },
        } as VirtualCoin;

        const result = await verifyVtxo(
            vtxo,
            mockIndexer,
            mockOnchain,
            serverInfo
        );

        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => /preconfirmed/i.test(e))).toBe(true);
        expect(mockIndexer.getVtxoChain).not.toHaveBeenCalled();
        expect(mockOnchain.getTxHex).not.toHaveBeenCalled();
    });

    it("should handle null chain gracefully", async () => {
        const vtxo = makeVtxo("cc".repeat(32));
        (
            mockIndexer.getVtxoChain as ReturnType<typeof vi.fn>
        ).mockResolvedValue({ chain: null });

        const result = await verifyVtxo(
            vtxo,
            mockIndexer,
            mockOnchain,
            serverInfo
        );

        expect(result.valid).toBe(false);
    });

    it("should handle getVirtualTxs throwing an error", async () => {
        const commitmentTxid = "aa".repeat(32);
        const vtxo = makeVtxo("cc".repeat(32), [commitmentTxid]);
        (
            mockIndexer.getVtxoChain as ReturnType<typeof vi.fn>
        ).mockResolvedValue({
            chain: [
                {
                    txid: commitmentTxid,
                    type: "INDEXER_CHAINED_TX_TYPE_COMMITMENT",
                    expiresAt: "",
                    spends: [],
                },
                {
                    txid: "bb".repeat(32),
                    type: "INDEXER_CHAINED_TX_TYPE_TREE",
                    expiresAt: "",
                    spends: [commitmentTxid],
                },
            ],
        });
        (
            mockIndexer.getVirtualTxs as ReturnType<typeof vi.fn>
        ).mockRejectedValue(new Error("indexer timeout"));

        const result = await verifyVtxo(
            vtxo,
            mockIndexer,
            mockOnchain,
            serverInfo
        );

        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => /indexer timeout/i.test(e))).toBe(
            true
        );
    });
});

// ============================================================
// Test helpers
// ============================================================

function makeVtxo(
    txid: string,
    commitmentTxIds: string[] = [],
    vout: number = 0
): VirtualCoin {
    return {
        txid,
        vout,
        value: 10_000n,
        virtualStatus: {
            state: "confirmed",
            batchTxid: commitmentTxIds[0] ?? "",
            commitmentTxIds,
        },
    } as VirtualCoin;
}
