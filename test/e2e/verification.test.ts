import { describe, it, expect, beforeEach } from "vitest";
import { hex } from "@scure/base";
import { RestArkProvider, verifyVtxo } from "../../src";
import {
    beforeEachFaucet,
    createTestArkWallet,
    createVtxo,
    execCommand,
} from "./utils";

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
});
