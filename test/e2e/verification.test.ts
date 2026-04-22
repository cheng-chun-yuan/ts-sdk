import { describe, it, expect, beforeEach } from "vitest";
import { base64, hex } from "@scure/base";
import { Transaction } from "@scure/btc-signer";
import { RestArkProvider, verifyVtxo, type IndexerProvider } from "../../src";
import {
    beforeEachFaucet,
    createTestArkWallet,
    createVtxo,
    execCommand,
} from "./utils";

// Wrap a live IndexerProvider so getVtxoChain returns a tampered chain.
// The rest of the methods pass through to the real server.
function maliciousIndexer(
    real: IndexerProvider,
    mutate: (
        chain: Awaited<ReturnType<IndexerProvider["getVtxoChain"]>>["chain"]
    ) => Awaited<ReturnType<IndexerProvider["getVtxoChain"]>>["chain"]
): IndexerProvider {
    return new Proxy(real, {
        get(target, prop, receiver) {
            if (prop === "getVtxoChain") {
                return async (
                    ...args: Parameters<IndexerProvider["getVtxoChain"]>
                ) => {
                    const result = await target.getVtxoChain(...args);
                    return { ...result, chain: mutate(result.chain) };
                };
            }
            const value = Reflect.get(target, prop, receiver);
            return typeof value === "function" ? value.bind(target) : value;
        },
    });
}

// End-to-end regression guard for the Tier 1 client-side VTXO verifier.
// The unit suite exercises check logic with synthetic fixtures; this
// test proves verifyVtxo works against the real arkd/indexer wire
// format. Pre-fix (bug_021), every real checkpoint was marked invalid
// because its expiry is a unix-seconds string the parser read as NaN.
describe("verifyVtxo — regtest integration", () => {
    beforeEach(beforeEachFaucet, 20000);

    it(
        "does not report /invalid expiry timestamp/ on real indexer checkpoints (bug_021 regression)",
        { timeout: 120_000 },
        async () => {
            const alice = await createTestArkWallet();
            await createVtxo(alice, 50_000);

            // Settle broadcasts the commitment tx; mine a block so esplora
            // can return its hex for the onchain anchor check. Same
            // pattern as ark.test.ts:276 and vhtlc.test.ts:271.
            execCommand("nigiri rpc --generate 1");
            await new Promise((r) => setTimeout(r, 5000));

            const vtxos = await alice.wallet.getVtxos();
            expect(vtxos.length).toBeGreaterThan(0);
            const vtxo = vtxos[0];

            const arkProvider = new RestArkProvider("http://localhost:7070");
            const info = await arkProvider.getInfo();

            const result = await verifyVtxo(
                vtxo,
                alice.wallet.indexerProvider,
                alice.wallet.onchainProvider,
                {
                    // info.signerPubkey is 33-byte compressed hex; the
                    // verifier wants the 32-byte x-only half, matching
                    // wallet.ts:294.
                    pubkey: hex.decode(info.signerPubkey).slice(1),
                    sweepInterval: {
                        value: info.unilateralExitDelay,
                        type:
                            info.unilateralExitDelay >= 512n
                                ? "seconds"
                                : "blocks",
                    },
                },
                { minConfirmationDepth: 0 }
            );

            const checkpointExpiryErrors = result.errors.filter((e) =>
                /invalid expiry timestamp/i.test(e)
            );
            expect(checkpointExpiryErrors).toEqual([]);
            const checkpointErrors = result.errors.filter((e) =>
                /Checkpoint verification failed/i.test(e)
            );
            expect(checkpointErrors).toEqual([]);
        }
    );

    it(
        "rejects a tampered chain from an adversarial indexer",
        { timeout: 120_000 },
        async () => {
            // Proves the security claim unit tests cannot: a lying server
            // that mutates the indexer response on the real wire format
            // must be rejected. Unit fixtures are hand-built so they
            // can't catch a verifier that silently accepts drift.
            const alice = await createTestArkWallet();
            await createVtxo(alice, 50_000);

            execCommand("nigiri rpc --generate 1");
            await new Promise((r) => setTimeout(r, 5000));

            const vtxos = await alice.wallet.getVtxos();
            expect(vtxos.length).toBeGreaterThan(0);
            const vtxo = vtxos[0];

            // Point every non-root entry's parent at a garbage txid —
            // the chain no longer connects to the commitment.
            const tampered = maliciousIndexer(
                alice.wallet.indexerProvider,
                (chain) =>
                    chain.map((entry, idx) =>
                        idx === 0
                            ? entry
                            : { ...entry, spends: ["f".repeat(64)] }
                    )
            );

            const arkProvider = new RestArkProvider("http://localhost:7070");
            const info = await arkProvider.getInfo();

            const result = await verifyVtxo(
                vtxo,
                tampered,
                alice.wallet.onchainProvider,
                {
                    pubkey: hex.decode(info.signerPubkey).slice(1),
                    sweepInterval: {
                        value: info.unilateralExitDelay,
                        type:
                            info.unilateralExitDelay >= 512n
                                ? "seconds"
                                : "blocks",
                    },
                },
                { minConfirmationDepth: 0 }
            );

            expect(result.valid).toBe(false);
            expect(result.errors.length).toBeGreaterThan(0);
        }
    );

    it(
        "rejects a forged tapKeySig from an adversarial indexer",
        { timeout: 120_000 },
        async () => {
            // Wire-level proof that Schnorr verification fires on real
            // PSBT bytes: wrap the indexer so `getVirtualTxs` returns
            // PSBTs whose first-encountered tapKeySig has one byte flipped.
            // `verifyTreeSignatures` must reject this — otherwise the
            // ASP could forge branch signatures at will.
            const alice = await createTestArkWallet();
            await createVtxo(alice, 50_000);

            execCommand("nigiri rpc --generate 1");
            await new Promise((r) => setTimeout(r, 5000));

            const vtxos = await alice.wallet.getVtxos();
            expect(vtxos.length).toBeGreaterThan(0);
            const vtxo = vtxos[0];

            const real = alice.wallet.indexerProvider;
            const tampered = new Proxy(real, {
                get(target, prop, receiver) {
                    if (prop === "getVirtualTxs") {
                        return async (
                            ...args: Parameters<
                                IndexerProvider["getVirtualTxs"]
                            >
                        ) => {
                            const result = await target.getVirtualTxs(...args);
                            let mutated = false;
                            const txs = result.txs.map((psbtB64) => {
                                if (mutated) return psbtB64;
                                try {
                                    const tx = Transaction.fromPSBT(
                                        base64.decode(psbtB64)
                                    );
                                    for (let i = 0; i < tx.inputsLength; i++) {
                                        const input = tx.getInput(i);
                                        if (
                                            input.tapKeySig &&
                                            input.tapKeySig.length > 0
                                        ) {
                                            const forged = new Uint8Array(
                                                input.tapKeySig
                                            );
                                            forged[0] ^= 0xff;
                                            tx.updateInput(i, {
                                                tapKeySig: forged,
                                            });
                                            mutated = true;
                                            break;
                                        }
                                    }
                                    return base64.encode(tx.toPSBT());
                                } catch {
                                    return psbtB64;
                                }
                            });
                            return { ...result, txs };
                        };
                    }
                    const value = Reflect.get(target, prop, receiver);
                    return typeof value === "function"
                        ? value.bind(target)
                        : value;
                },
            });

            const arkProvider = new RestArkProvider("http://localhost:7070");
            const info = await arkProvider.getInfo();

            const result = await verifyVtxo(
                vtxo,
                tampered,
                alice.wallet.onchainProvider,
                {
                    pubkey: hex.decode(info.signerPubkey).slice(1),
                    sweepInterval: {
                        value: info.unilateralExitDelay,
                        type:
                            info.unilateralExitDelay >= 512n
                                ? "seconds"
                                : "blocks",
                    },
                },
                { minConfirmationDepth: 0 }
            );

            expect(result.valid).toBe(false);
            expect(
                result.errors.some((e) =>
                    /signature|tapKey|verify|invalid/i.test(e)
                )
            ).toBe(true);
        }
    );
});
