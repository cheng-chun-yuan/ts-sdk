import { expect, describe, it, beforeEach } from "vitest";
import { hex } from "@scure/base";
import {
    EsploraProvider,
    RestIndexerProvider,
    RestArkProvider,
} from "../../src";
import { verifyVtxo } from "../../src/verification";
import {
    createTestArkWallet,
    createVtxo,
    beforeEachFaucet,
    execCommand,
} from "./utils";

const ESPLORA_URL = "http://localhost:3000";
const INDEXER_URL = "http://localhost:7070";
const ARK_URL = "http://localhost:7070";

function mineBlock() {
    execCommand("nigiri rpc -generate 1");
}

async function waitForEsplora(
    onchain: EsploraProvider,
    txid: string,
    timeoutMs = 30000
) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const status = await onchain.getTxStatus(txid);
            if (status.confirmed) return;
        } catch {
            // not found yet
        }
        mineBlock();
        await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error(`Timeout waiting for tx ${txid} to confirm`);
}

describe("VTXO Verification - Integration (Tier 1)", () => {
    beforeEach(beforeEachFaucet, 20000);

    it(
        "should verify a real VTXO end-to-end",
        { timeout: 120000 },
        async () => {
            const alice = await createTestArkWallet();
            const indexer = new RestIndexerProvider(INDEXER_URL);
            const arkProvider = new RestArkProvider(ARK_URL);
            const onchain = new EsploraProvider(ESPLORA_URL, {
                forcePolling: true,
                pollingInterval: 2000,
            });

            await createVtxo(alice, 10_000);

            const vtxos = await alice.wallet.getVtxos();
            expect(vtxos.length).toBeGreaterThan(0);

            const vtxo = vtxos[0];
            const info = await arkProvider.getInfo();

            const serverPubKey = hex.decode(info.signerPubkey).slice(1);
            const sweepInterval = {
                value: info.boardingExitDelay,
                type:
                    info.boardingExitDelay < 512n
                        ? ("blocks" as const)
                        : ("seconds" as const),
            };

            const commitmentTxid = vtxo.virtualStatus?.commitmentTxIds?.[0];
            if (commitmentTxid) {
                await waitForEsplora(onchain, commitmentTxid);
            }

            const result = await verifyVtxo(
                vtxo,
                indexer,
                onchain,
                { pubkey: serverPubKey, sweepInterval },
                { verifySignatures: true }
            );

            console.log("verifyVtxo result:", JSON.stringify(result, null, 2));

            expect(result.commitmentTxid).toBeTruthy();
            expect(result.chainLength).toBeGreaterThan(0);
        }
    );

    it(
        "should verify a real commitment tx onchain",
        { timeout: 60000 },
        async () => {
            const alice = await createTestArkWallet();
            const onchain = new EsploraProvider(ESPLORA_URL, {
                forcePolling: true,
                pollingInterval: 2000,
            });

            await createVtxo(alice, 10_000);

            const vtxos = await alice.wallet.getVtxos();
            const vtxo = vtxos[0];
            const commitmentTxid = vtxo.virtualStatus?.commitmentTxIds?.[0];
            expect(commitmentTxid).toBeTruthy();

            await waitForEsplora(onchain, commitmentTxid!);

            const txHex = await onchain.getTxHex(commitmentTxid!);
            expect(txHex).toBeTruthy();
            expect(txHex.length).toBeGreaterThan(0);

            const txStatus = await onchain.getTxStatus(commitmentTxid!);
            expect(txStatus.confirmed).toBe(true);
        }
    );
});

describe("VTXO Verification - Integration (Tier 2: Script Satisfaction)", () => {
    beforeEach(beforeEachFaucet, 20000);

    it(
        "should fetch and decode tapscripts from a real VTXO tree",
        { timeout: 120000 },
        async () => {
            const alice = await createTestArkWallet();
            const indexer = new RestIndexerProvider(INDEXER_URL);
            const onchain = new EsploraProvider(ESPLORA_URL, {
                forcePolling: true,
                pollingInterval: 2000,
            });

            await createVtxo(alice, 10_000);

            const vtxos = await alice.wallet.getVtxos();
            expect(vtxos.length).toBeGreaterThan(0);

            const vtxo = vtxos[0];
            const commitmentTxid = vtxo.virtualStatus?.commitmentTxIds?.[0];
            expect(commitmentTxid).toBeTruthy();

            await waitForEsplora(onchain, commitmentTxid!);

            // Fetch the tree and get PSBTs
            const { vtxoTree } = await indexer.getVtxoTree({
                txid: commitmentTxid!,
                vout: 0,
            });
            expect(vtxoTree.length).toBeGreaterThan(0);

            const txids = vtxoTree.map((n) => n.txid);
            const { txs } = await indexer.getVirtualTxs(txids);
            expect(txs.length).toBe(txids.length);

            // Parse PSBTs and check tapscript structure
            const { base64: b64 } = await import("@scure/base");
            const { Transaction } = await import("../../src/utils/transaction");
            const { verifyTaprootScriptTree } = await import(
                "../../src/verification/scriptVerifier"
            );

            for (const psbt of txs) {
                const tx = Transaction.fromPSBT(b64.decode(psbt));
                for (let i = 0; i < tx.inputsLength; i++) {
                    const input = tx.getInput(i);
                    if (input.tapLeafScript && input.tapLeafScript.length > 0) {
                        const result = verifyTaprootScriptTree(tx, i);
                        console.log(
                            `Tapscript: ${result.leafType} (valid: ${result.valid})`
                        );
                        expect(result.leafType).not.toBe("unknown");
                    }
                }
            }
        }
    );
});
