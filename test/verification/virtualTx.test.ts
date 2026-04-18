import { describe, expect, it } from "vitest";
import { base64 } from "@scure/base";
import { randomPrivateKeyBytes } from "@scure/btc-signer/utils.js";
import {
    parseVirtualTx,
    VirtualTxIntegrityError,
} from "../../src/verification/virtualTx";
import { Transaction } from "../../src/utils/transaction";
import { SingleKey } from "../../src/identity/singleKey";

describe("parseVirtualTx", () => {
    it("returns the parsed tx when the computed txid matches", async () => {
        const { psbt, txid } = await buildPsbt();

        const tx = parseVirtualTx(txid, psbt);

        expect(tx.id).toBe(txid);
    });

    it("throws VirtualTxIntegrityError when the txid is swapped", async () => {
        const { psbt } = await buildPsbt();
        const wrongTxid = "ff".repeat(32);

        expect(() => parseVirtualTx(wrongTxid, psbt)).toThrow(
            VirtualTxIntegrityError
        );
    });

    it("exposes expected and computed txids on the integrity error", async () => {
        const { psbt, txid: realTxid } = await buildPsbt();
        const claimedTxid = "aa".repeat(32);

        try {
            parseVirtualTx(claimedTxid, psbt);
            expect.fail("expected parseVirtualTx to throw");
        } catch (err) {
            expect(err).toBeInstanceOf(VirtualTxIntegrityError);
            const e = err as VirtualTxIntegrityError;
            expect(e.expectedTxid).toBe(claimedTxid);
            expect(e.computedTxid).toBe(realTxid);
        }
    });

    it("propagates the underlying parse error for malformed PSBTs", () => {
        const garbage = base64.encode(new Uint8Array([0, 1, 2, 3]));

        expect(() => parseVirtualTx("aa".repeat(32), garbage)).toThrow();
        // Not an integrity error — callers can use that to distinguish.
        try {
            parseVirtualTx("aa".repeat(32), garbage);
        } catch (err) {
            expect(err).not.toBeInstanceOf(VirtualTxIntegrityError);
        }
    });
});

async function buildPsbt(): Promise<{ psbt: string; txid: string }> {
    const tx = new Transaction();
    const inputKey = await SingleKey.fromPrivateKey(
        randomPrivateKeyBytes()
    ).xOnlyPublicKey();
    const outputKey = await SingleKey.fromPrivateKey(
        randomPrivateKeyBytes()
    ).xOnlyPublicKey();
    tx.addOutput({ script: taprootOutputScript(outputKey), amount: 10_000n });
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
