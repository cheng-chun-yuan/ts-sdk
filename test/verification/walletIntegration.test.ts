import { describe, it, expect, vi } from "vitest";
import type { VirtualCoin } from "../../src/wallet";

/**
 * Tests for Wallet.verifyVtxo() and Wallet.verifyAllVtxos() wrappers.
 * These methods delegate to the standalone verifyVtxo/verifyAllVtxos
 * functions, wiring up indexer, onchain, and serverInfo from Wallet internals.
 *
 * Since Wallet construction requires a real arkProvider.getInfo() call,
 * these are kept as lightweight checks on the standalone functions
 * via the same interface the Wallet methods use.
 */
describe("Wallet verification method contract", () => {
    it("verifyVtxo should return VtxoVerificationResult shape", async () => {
        // Import the standalone function (same as Wallet calls internally)
        const { verifyVtxo } = await import(
            "../../src/verification/vtxoChainVerifier"
        );

        const mockIndexer = {
            getVtxoChain: vi.fn().mockResolvedValue({ chain: [] }),
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
        } as any;

        const mockOnchain = {
            getTxStatus: vi.fn(),
            getChainTip: vi.fn(),
            getTxHex: vi.fn(),
            getTxOutspends: vi.fn(),
            getCoins: vi.fn(),
            getFeeRate: vi.fn(),
            broadcastTransaction: vi.fn(),
            getTransactions: vi.fn(),
            watchAddresses: vi.fn(),
        } as any;

        const vtxo = {
            txid: "aa".repeat(32),
            vout: 0,
            value: 10_000n,
            virtualStatus: {
                state: "confirmed",
                batchTxid: "",
                commitmentTxIds: [],
            },
        } as VirtualCoin;

        const result = await verifyVtxo(vtxo, mockIndexer, mockOnchain, {
            pubkey: new Uint8Array(32),
            sweepInterval: { value: 144n, type: "blocks" as const },
        });

        // Verify the result shape matches what Wallet.verifyVtxo() returns
        expect(result).toHaveProperty("valid");
        expect(result).toHaveProperty("vtxoOutpoint");
        expect(result).toHaveProperty("commitmentTxid");
        expect(result).toHaveProperty("confirmationDepth");
        expect(result).toHaveProperty("chainLength");
        expect(result).toHaveProperty("errors");
        expect(result).toHaveProperty("warnings");
        expect(result.vtxoOutpoint.txid).toBe(vtxo.txid);
        expect(result.vtxoOutpoint.vout).toBe(vtxo.vout);
    });

    it("verifyAllVtxos should return Map keyed by outpoint", async () => {
        const { verifyAllVtxos } = await import(
            "../../src/verification/vtxoChainVerifier"
        );

        const mockIndexer = {
            getVtxoChain: vi.fn().mockResolvedValue({ chain: [] }),
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
        } as any;

        const mockOnchain = {
            getTxStatus: vi.fn(),
            getChainTip: vi.fn(),
            getTxHex: vi.fn(),
            getTxOutspends: vi.fn(),
            getCoins: vi.fn(),
            getFeeRate: vi.fn(),
            broadcastTransaction: vi.fn(),
            getTransactions: vi.fn(),
            watchAddresses: vi.fn(),
        } as any;

        const vtxo1 = {
            txid: "aa".repeat(32),
            vout: 0,
            value: 10_000n,
            virtualStatus: {
                state: "confirmed",
                batchTxid: "",
                commitmentTxIds: [],
            },
        } as VirtualCoin;

        const vtxo2 = {
            txid: "bb".repeat(32),
            vout: 1,
            value: 20_000n,
            virtualStatus: {
                state: "confirmed",
                batchTxid: "",
                commitmentTxIds: [],
            },
        } as VirtualCoin;

        const results = await verifyAllVtxos(
            [vtxo1, vtxo2],
            mockIndexer,
            mockOnchain,
            {
                pubkey: new Uint8Array(32),
                sweepInterval: { value: 144n, type: "blocks" as const },
            }
        );

        expect(results).toBeInstanceOf(Map);
        expect(results.size).toBe(2);
        expect(results.has(`${"aa".repeat(32)}:0`)).toBe(true);
        expect(results.has(`${"bb".repeat(32)}:1`)).toBe(true);
    });
});

describe("errorMessage shared utility", () => {
    it("should extract message from Error objects", async () => {
        const { errorMessage } = await import("../../src/verification/utils");
        expect(errorMessage(new Error("test error"))).toBe("test error");
    });

    it("should stringify non-Error values", async () => {
        const { errorMessage } = await import("../../src/verification/utils");
        expect(errorMessage("string error")).toBe("string error");
        expect(errorMessage(42)).toBe("42");
        expect(errorMessage(null)).toBe("null");
    });
});

describe("compareBytes usage consistency", () => {
    it("onchainAnchorVerifier uses compareBytes for script comparison", async () => {
        // This is a structural check — read the source to confirm
        const fs = await import("fs");
        const source = fs.readFileSync(
            "src/verification/onchainAnchorVerifier.ts",
            "utf-8"
        );
        expect(source).toContain("compareBytes(output.script, expectedScript)");
        expect(source).not.toContain(
            "hex.encode(output.script) === hex.encode(expectedScript)"
        );
    });

    it("signatureVerifier uses compareBytes for key comparison", async () => {
        const fs = await import("fs");
        const source = fs.readFileSync(
            "src/verification/signatureVerifier.ts",
            "utf-8"
        );
        expect(source).toContain(
            "compareBytes(finalKey.slice(1), previousScriptKey)"
        );
        expect(source).toContain(
            "compareBytes(internalKey, TAPROOT_UNSPENDABLE_KEY)"
        );
    });

    it("scriptVerifier uses compareBytes for hash comparison", async () => {
        const fs = await import("fs");
        const source = fs.readFileSync(
            "src/verification/scriptVerifier.ts",
            "utf-8"
        );
        expect(source).toContain("compareBytes(computedHash, expectedHash)");
        expect(source).not.toContain("hex.encode(computedHash)");
    });
});

describe("double-spend check is warning, not error", () => {
    it("onchainAnchorVerifier pushes to warnings for spent output", async () => {
        const fs = await import("fs");
        const source = fs.readFileSync(
            "src/verification/onchainAnchorVerifier.ts",
            "utf-8"
        );
        // The spent-output check should push to warnings, not errors
        const spentBlock = source.slice(
            source.indexOf("doubleSpent = true"),
            source.indexOf("doubleSpent = true") + 200
        );
        expect(spentBlock).toContain("warnings.push");
        expect(spentBlock).not.toContain("errors.push");
    });
});
