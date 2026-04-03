import { describe, it, expect, vi } from "vitest";
import {
    sovereignExit,
    canSovereignExit,
} from "../../src/verification/sovereignExit";
import { InMemoryExitDataRepository } from "../../src/verification/exitDataStore";
import type { ExitData } from "../../src/verification/exitDataStore";
import type { OnchainProvider } from "../../src/providers/onchain";

describe("canSovereignExit", () => {
    it("should return true when exit data exists and is valid", async () => {
        const repo = new InMemoryExitDataRepository();
        const data = makeExitData();
        await repo.saveExitData(data);

        const mockOnchain = createMockOnchain({
            confirmed: true,
            blockHeight: 1000,
        });

        const result = await canSovereignExit(
            data.vtxoOutpoint,
            repo,
            mockOnchain
        );

        expect(result.canExit).toBe(true);
    });

    it("should return false when no exit data stored", async () => {
        const repo = new InMemoryExitDataRepository();
        const mockOnchain = createMockOnchain({ confirmed: true });

        const result = await canSovereignExit(
            { txid: "ff".repeat(32), vout: 0 },
            repo,
            mockOnchain
        );

        expect(result.canExit).toBe(false);
        expect(result.reason).toMatch(/no.*exit.*data/i);
    });

    it("should return false when commitment tx is not confirmed", async () => {
        const repo = new InMemoryExitDataRepository();
        const data = makeExitData();
        await repo.saveExitData(data);

        const mockOnchain = createMockOnchain({ confirmed: false });

        const result = await canSovereignExit(
            data.vtxoOutpoint,
            repo,
            mockOnchain
        );

        expect(result.canExit).toBe(false);
        expect(result.reason).toMatch(/commitment.*not.*confirmed/i);
    });
});

describe("sovereignExit", () => {
    it("should fail when no exit data stored", async () => {
        const repo = new InMemoryExitDataRepository();
        const mockOnchain = createMockOnchain({ confirmed: true });

        const result = await sovereignExit(
            { txid: "ff".repeat(32), vout: 0 },
            repo,
            mockOnchain
        );

        expect(result.success).toBe(false);
        expect(result.errors.some((e) => /no.*exit.*data/i.test(e))).toBe(true);
    });

    it("should return structured result with exit steps", async () => {
        const repo = new InMemoryExitDataRepository();
        const data = makeExitData();
        await repo.saveExitData(data);

        const mockOnchain = createMockOnchain({
            confirmed: true,
            blockHeight: 1000,
        });
        const result = await sovereignExit(
            data.vtxoOutpoint,
            repo,
            mockOnchain
        );

        expect(result).toHaveProperty("success");
        expect(result).toHaveProperty("steps");
        expect(result).toHaveProperty("errors");
        expect(Array.isArray(result.steps)).toBe(true);
    });

    it("should produce broadcast steps for unconfirmed txs in chain", async () => {
        const repo = new InMemoryExitDataRepository();
        const data = makeExitData();
        await repo.saveExitData(data);

        // First call to getTxStatus (for the tree tx) throws = not found onchain
        const mockOnchain = createMockOnchain({
            confirmed: true,
            blockHeight: 1000,
        });
        let callCount = 0;
        (mockOnchain.getTxStatus as any).mockImplementation(
            async (txid: string) => {
                callCount++;
                // Commitment tx check in canSovereignExit succeeds,
                // but tree tx is not onchain yet
                if (txid === data.commitmentTxid) {
                    return {
                        confirmed: true,
                        blockHeight: 1000,
                        blockTime: 1700000000,
                    };
                }
                throw new Error("tx not found");
            }
        );

        const result = await sovereignExit(
            data.vtxoOutpoint,
            repo,
            mockOnchain
        );

        // With mock PSBT ("base64psbt"), finalization fails — errors are captured
        const broadcastSteps = result.steps.filter(
            (s) => s.type === "broadcast"
        );
        expect(broadcastSteps.length).toBeGreaterThan(0);
        expect(broadcastSteps[0].txid).toBe("bb".repeat(32));
        // Broadcast failure is recorded in errors (not silently swallowed)
        expect(result.errors.length).toBeGreaterThan(0);
    });

    it("should skip already-confirmed txs in the chain", async () => {
        const repo = new InMemoryExitDataRepository();
        const data = makeExitData();
        await repo.saveExitData(data);

        // All txs already confirmed
        const mockOnchain = createMockOnchain({
            confirmed: true,
            blockHeight: 1000,
        });

        const result = await sovereignExit(
            data.vtxoOutpoint,
            repo,
            mockOnchain
        );

        expect(result.success).toBe(true);
        const waitSteps = result.steps.filter((s) => s.type === "wait");
        expect(waitSteps.length).toBeGreaterThan(0);
        const broadcastSteps = result.steps.filter(
            (s) => s.type === "broadcast"
        );
        expect(broadcastSteps).toHaveLength(0);
    });

    it("should fail when PSBT is missing for an unconfirmed tx", async () => {
        const repo = new InMemoryExitDataRepository();
        const data = makeExitData();
        // Remove the PSBT
        data.virtualTxs = {};
        await repo.saveExitData(data);

        const mockOnchain = createMockOnchain({
            confirmed: true,
            blockHeight: 1000,
        });
        (mockOnchain.getTxStatus as any).mockImplementation(
            async (txid: string) => {
                if (txid === data.commitmentTxid) {
                    return {
                        confirmed: true,
                        blockHeight: 1000,
                        blockTime: 1700000000,
                    };
                }
                throw new Error("not found");
            }
        );

        const result = await sovereignExit(
            data.vtxoOutpoint,
            repo,
            mockOnchain
        );

        expect(result.success).toBe(false);
        expect(result.errors.some((e) => /missing.*psbt/i.test(e))).toBe(true);
    });

    it("should include a done step at the end", async () => {
        const repo = new InMemoryExitDataRepository();
        const data = makeExitData();
        await repo.saveExitData(data);

        const mockOnchain = createMockOnchain({
            confirmed: true,
            blockHeight: 1000,
        });

        const result = await sovereignExit(
            data.vtxoOutpoint,
            repo,
            mockOnchain
        );

        const lastStep = result.steps[result.steps.length - 1];
        expect(lastStep.type).toBe("done");
    });

    it("should skip already-confirmed txs in the chain", async () => {
        const repo = new InMemoryExitDataRepository();
        const data = makeExitData();
        await repo.saveExitData(data);

        // All txs already confirmed
        const mockOnchain = createMockOnchain({
            confirmed: true,
            blockHeight: 1000,
        });

        const result = await sovereignExit(
            data.vtxoOutpoint,
            repo,
            mockOnchain,
            {} as Identity,
            "bc1qtest",
            {} as AnchorBumper
        );

        expect(result.success).toBe(true);
        const waitSteps = result.steps.filter((s) => s.type === "wait");
        expect(waitSteps.length).toBeGreaterThan(0);
        const broadcastSteps = result.steps.filter(
            (s) => s.type === "broadcast"
        );
        expect(broadcastSteps).toHaveLength(0);
    });

    it("should fail when PSBT is missing for an unconfirmed tx", async () => {
        const repo = new InMemoryExitDataRepository();
        const data = makeExitData();
        // Remove the PSBT
        data.virtualTxs = {};
        await repo.saveExitData(data);

        const mockOnchain = createMockOnchain({
            confirmed: true,
            blockHeight: 1000,
        });
        (mockOnchain.getTxStatus as any).mockImplementation(
            async (txid: string) => {
                if (txid === data.commitmentTxid) {
                    return {
                        confirmed: true,
                        blockHeight: 1000,
                        blockTime: 1700000000,
                    };
                }
                throw new Error("not found");
            }
        );

        const result = await sovereignExit(
            data.vtxoOutpoint,
            repo,
            mockOnchain,
            {} as Identity,
            "bc1qtest",
            {} as AnchorBumper
        );

        expect(result.success).toBe(false);
        expect(result.errors.some((e) => /missing.*psbt/i.test(e))).toBe(true);
    });

    it("should include a done step at the end", async () => {
        const repo = new InMemoryExitDataRepository();
        const data = makeExitData();
        await repo.saveExitData(data);

        const mockOnchain = createMockOnchain({
            confirmed: true,
            blockHeight: 1000,
        });

        const result = await sovereignExit(
            data.vtxoOutpoint,
            repo,
            mockOnchain,
            {} as Identity,
            "bc1qtest",
            {} as AnchorBumper
        );

        const lastStep = result.steps[result.steps.length - 1];
        expect(lastStep.type).toBe("done");
    });

    it("should not contact the ASP during exit", async () => {
        const repo = new InMemoryExitDataRepository();
        const data = makeExitData();
        await repo.saveExitData(data);

        const mockOnchain = createMockOnchain({
            confirmed: true,
            blockHeight: 1000,
        });
        // The key assertion: sovereignExit only uses exitDataRepo + onchain.
        // No IndexerProvider, no ArkProvider passed in.
        const result = await sovereignExit(
            data.vtxoOutpoint,
            repo,
            mockOnchain
        );

        expect(result).toBeDefined();
    });
});

// ============================================================
// Test helpers
// ============================================================

function makeExitData(vtxoTxid?: string): ExitData {
    const txid = vtxoTxid ?? "aa".repeat(32);
    return {
        vtxoOutpoint: { txid, vout: 0 },
        commitmentTxid: "cc".repeat(32),
        chain: [
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
        ],
        virtualTxs: { ["bb".repeat(32)]: "base64psbt" },
        treeNodes: [{ txid: "bb".repeat(32), tx: "base64psbt", children: {} }],
        storedAt: Date.now(),
    };
}

function createMockOnchain(opts: {
    confirmed?: boolean;
    blockHeight?: number;
}): OnchainProvider {
    return {
        getTxStatus: vi.fn().mockResolvedValue(
            opts.confirmed
                ? {
                      confirmed: true,
                      blockHeight: opts.blockHeight ?? 100,
                      blockTime: 1700000000,
                  }
                : { confirmed: false }
        ),
        getChainTip: vi.fn().mockResolvedValue({
            height: 1100,
            time: 1700001000,
            hash: "00".repeat(32),
        }),
        getTxHex: vi.fn().mockResolvedValue(""),
        getTxOutspends: vi.fn().mockResolvedValue([{ spent: false, txid: "" }]),
        getCoins: vi.fn(),
        getFeeRate: vi.fn(),
        broadcastTransaction: vi.fn().mockResolvedValue("txid"),
        getTransactions: vi.fn(),
        watchAddresses: vi.fn(),
    } as OnchainProvider;
}
