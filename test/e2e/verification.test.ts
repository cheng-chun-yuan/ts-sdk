import { describe, it, expect, beforeEach } from "vitest";
import { base64, hex } from "@scure/base";
import { Transaction } from "@scure/btc-signer";
import { hash160 } from "@scure/btc-signer/utils.js";
import {
    EsploraProvider,
    ExitDataStore,
    InMemoryContractRepository,
    InMemoryWalletRepository,
    networks,
    RestArkProvider,
    RestIndexerProvider,
    sovereignExit,
    VHTLC,
    verifyVtxo,
    Wallet,
    type IndexerProvider,
} from "../../src";
import { InMemoryStorageAdapter } from "../../src/storage/inMemory";
import {
    arkdExec,
    beforeEachFaucet,
    createTestArkWallet,
    createTestIdentity,
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

    it(
        "verifies a Boltz-style submarine swap VHTLC (hash preimage on ConditionCSVMultisig leaf)",
        { timeout: 120_000 },
        async () => {
            // Tier 2.3 demonstration per spec: a Boltz Ark↔LN submarine
            // swap is secured by a VHTLC on the Ark side whose exit leaf
            // is a ConditionCSVMultisig — an HTLC-style hash preimage
            // script combined with a CSV timelock. Funding a real VHTLC
            // through arkd and running verifyVtxo exercises exactly the
            // hash-preimage verification path used in Boltz swaps, against
            // arkd's actual taproot byte layout. Unit fixtures encode
            // these via our own helpers, so only a real VHTLC funded
            // through arkd catches wire-format drift on this path.
            const sender = createTestIdentity();
            const receiver = createTestIdentity();
            const arkProvider = new RestArkProvider("http://localhost:7070");
            const indexerProvider = new RestIndexerProvider(
                "http://localhost:7070"
            );
            const info = await arkProvider.getInfo();
            const serverPubkey = hex.decode(info.signerPubkey).slice(1);

            const preimage = new TextEncoder().encode("preimage");
            const vhtlcScript = new VHTLC.Script({
                preimageHash: hash160(preimage),
                sender: await sender.xOnlyPublicKey(),
                receiver: await receiver.xOnlyPublicKey(),
                server: serverPubkey,
                refundLocktime: BigInt(1000),
                unilateralClaimDelay: { type: "blocks", value: 100n },
                unilateralRefundDelay: { type: "blocks", value: 50n },
                unilateralRefundWithoutReceiverDelay: {
                    type: "blocks",
                    value: 50n,
                },
            });

            const address = vhtlcScript
                .address(networks.regtest.hrp, serverPubkey)
                .encode();
            execCommand(
                `${arkdExec} ark send --to ${address} --amount 1000 --password secret`
            );
            await new Promise((r) => setTimeout(r, 2000));

            execCommand("nigiri rpc --generate 1");
            await new Promise((r) => setTimeout(r, 5000));

            const { vtxos } = await indexerProvider.getVtxos({
                scripts: [hex.encode(vhtlcScript.pkScript)],
                spendableOnly: true,
            });
            expect(vtxos.length).toBe(1);

            const result = await verifyVtxo(
                vtxos[0],
                indexerProvider,
                // A minimal wallet is cheaper than spinning up its own
                // EsploraProvider — reuse a throwaway alice's.
                (await createTestArkWallet()).wallet.onchainProvider,
                {
                    pubkey: serverPubkey,
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

            const scriptErrors = result.errors.filter((e) =>
                /script satisfaction|taproot leaf|condition|hash preimage/i.test(
                    e
                )
            );
            expect(scriptErrors).toEqual([]);
        }
    );

    it(
        "sovereignExit broadcasts the virtual tx chain against real indexer PSBTs",
        { timeout: 180_000 },
        async () => {
            // Unit tests mock broadcastTransaction and synthesize PSBTs;
            // they can't prove the topo-sort + broadcast loop handles
            // arkd's actual virtual-tx PSBT byte layout. This test lets
            // sovereignExit walk a real chain without the final-claim
            // options so we only exercise the tree-walk path.
            const identity = createTestIdentity();
            const exitDataRepository = new ExitDataStore(
                new InMemoryStorageAdapter()
            );
            const alice = {
                identity,
                wallet: await Wallet.create({
                    identity,
                    arkServerUrl: "http://localhost:7070",
                    onchainProvider: new EsploraProvider(
                        "http://localhost:3000",
                        { forcePolling: true, pollingInterval: 2000 }
                    ),
                    storage: {
                        walletRepository: new InMemoryWalletRepository(),
                        contractRepository: new InMemoryContractRepository(),
                        exitDataRepository,
                    },
                    settlementConfig: false,
                }),
            };
            await createVtxo(alice, 50_000);

            execCommand("nigiri rpc --generate 1");
            await new Promise((r) => setTimeout(r, 5000));

            const vtxos = await alice.wallet.getVtxos();
            expect(vtxos.length).toBeGreaterThan(0);
            const vtxo = vtxos[0];

            const result = await sovereignExit(
                { txid: vtxo.txid, vout: vtxo.vout },
                exitDataRepository,
                alice.wallet.onchainProvider
                // No identity/outputAddress/network → chain broadcast only.
            );

            // The walker produces a "broadcast" (or "wait") step per
            // virtual tx. We can't broadcast them successfully without a
            // fee-paying final claim (virtual txs carry zero fee and
            // bitcoin core's minrelayfee ≥ 1 sat/vB rejects them), so
            // treat the min-relay rejection as a success signal that
            // the walker reached bitcoin core with a real PSBT. Any
            // other error would indicate a genuine bug in the topo sort
            // or PSBT handling.
            expect(result.steps.length).toBeGreaterThan(0);
            const broadcastSteps = result.steps.filter(
                (s) => s.type === "broadcast"
            );
            expect(broadcastSteps.length).toBeGreaterThan(0);
            const nonFeeErrors = result.errors.filter(
                (e) => !/min relay fee|mempool-min-fee/i.test(e)
            );
            expect(nonFeeErrors).toEqual([]);
        }
    );
});
