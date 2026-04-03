import { describe, it, expect } from "vitest";
import { hash160 } from "@scure/btc-signer/utils.js";
import { randomPrivateKeyBytes } from "@scure/btc-signer/utils.js";
import * as bip68 from "bip68";
import { SingleKey } from "../../src/identity/singleKey";
import {
    CSVMultisigTapscript,
    CLTVMultisigTapscript,
    ConditionCSVMultisigTapscript,
    ConditionMultisigTapscript,
    MultisigTapscript,
} from "../../src/script/tapscript";
import { VtxoScript } from "../../src/script/base";
import { Transaction as ArkTransaction } from "../../src/utils/transaction";
import { Script } from "@scure/btc-signer";
import {
    setArkPsbtField,
    ConditionWitness,
} from "../../src/utils/unknownFields";
import {
    verifyTaprootScriptTree,
    verifyCSV,
    verifyCLTV,
    verifyHashPreimage,
    verifyScriptSatisfaction,
} from "../../src/verification/scriptVerifier";
import type { ChainTip } from "../../src/verification/scriptVerifier";

// ============================================================
// §1: Taproot script tree verification
// ============================================================

describe("verifyTaprootScriptTree", () => {
    it("should pass for a valid tapLeafScript with Merkle proof", async () => {
        const { tx } = await buildCSVTx();
        const result = verifyTaprootScriptTree(tx, 0);

        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
    });

    it("should fail when tapLeafScript is missing", async () => {
        const destScript = taprootOutputScript(
            await SingleKey.fromPrivateKey(
                randomPrivateKeyBytes()
            ).xOnlyPublicKey()
        );
        const tx = new ArkTransaction();
        tx.addInput({
            txid: new Uint8Array(32).fill(0x01),
            index: 0,
            witnessUtxo: { script: destScript, amount: 10_000n },
        });
        tx.addOutput({ script: destScript, amount: 10_000n });

        const result = verifyTaprootScriptTree(tx, 0);

        expect(result.valid).toBe(false);
        expect(
            result.errors.some((e) => /tapLeafScript|missing/i.test(e))
        ).toBe(true);
    });

    it("should verify leaf hash matches the script content", async () => {
        const { tx } = await buildCSVTx();
        const result = verifyTaprootScriptTree(tx, 0);

        expect(result.valid).toBe(true);
        expect(result.leafType).toBeDefined();
    });
});

// ============================================================
// §2: CSV (OP_CHECKSEQUENCEVERIFY) verification
// ============================================================

describe("verifyCSV", () => {
    const chainTip: ChainTip = { height: 1000, time: 1700000000 };

    it("should pass when nSequence satisfies the CSV requirement", async () => {
        const { tx } = await buildCSVTx({ csvBlocks: 144n });
        const result = verifyCSV(tx, 0, chainTip);

        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
    });

    it("should fail when nSequence is too low for CSV", async () => {
        const { tx } = await buildCSVTx({
            csvBlocks: 144n,
            sequenceOverride: 10,
        });
        const result = verifyCSV(tx, 0, chainTip);

        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => /sequence|CSV/i.test(e))).toBe(true);
    });

    it("should fail when CSV type (blocks vs seconds) is inconsistent", async () => {
        const { tx } = await buildCSVTx({
            csvSeconds: 512n,
            sequenceOverride: 10, // block-based sequence
        });
        const result = verifyCSV(tx, 0, chainTip);

        expect(result.valid).toBe(false);
        expect(
            result.errors.some((e) => /type|domain|inconsistent/i.test(e))
        ).toBe(true);
    });

    it("should handle seconds-based CSV correctly", async () => {
        const { tx } = await buildCSVTx({ csvSeconds: 512n });
        const result = verifyCSV(tx, 0, chainTip);

        expect(result.valid).toBe(true);
    });
});

// ============================================================
// §2: CLTV (OP_CHECKLOCKTIMEVERIFY) verification
// ============================================================

describe("verifyCLTV", () => {
    const chainTip: ChainTip = { height: 1000, time: 1700000000 };

    it("should pass when nLockTime satisfies the CLTV requirement", async () => {
        const { tx } = await buildCLTVTx({ locktime: 900n });
        const result = verifyCLTV(tx, 0, chainTip);

        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
    });

    it("should fail when nLockTime is below the CLTV value", async () => {
        const { tx } = await buildCLTVTx({
            locktime: 2000n,
            nLockTimeOverride: 500,
        });
        const result = verifyCLTV(tx, 0, chainTip);

        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => /locktime|CLTV/i.test(e))).toBe(true);
    });

    it("should fail when domain mismatch (blocks vs seconds)", async () => {
        const { tx } = await buildCLTVTx({
            locktime: 900n,
            nLockTimeOverride: 500_000_001,
        });
        const result = verifyCLTV(tx, 0, chainTip);

        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => /domain|type/i.test(e))).toBe(true);
    });

    it("should fail when nSequence disables locktime (0xFFFFFFFF)", async () => {
        const { tx } = await buildCLTVTx({
            locktime: 900n,
            disableLocktime: true,
        });
        const result = verifyCLTV(tx, 0, chainTip);

        expect(result.valid).toBe(false);
        expect(
            result.errors.some((e) => /sequence.*disable|locktime/i.test(e))
        ).toBe(true);
    });

    it("should handle time-based CLTV (>=500M boundary)", async () => {
        const timeLocktime = 1_700_000_000n; // time-based (>=500M)
        const tipWithTime: ChainTip = {
            height: 900_000,
            time: 1_700_000_100,
        };
        const { tx } = await buildCLTVTx({ locktime: timeLocktime });
        const result = verifyCLTV(tx, 0, tipWithTime);

        expect(result.valid).toBe(true);
    });
});

// ============================================================
// §3: Hash preimage verification (VHTLC / Boltz swap)
// ============================================================

describe("verifyHashPreimage", () => {
    it("should pass when HASH160 preimage matches the script hash", async () => {
        const { tx } = await buildConditionTx();
        const result = verifyHashPreimage(tx, 0);

        expect(result.valid).toBe(true);
        expect(result.errors).toHaveLength(0);
    });

    it("should fail when preimage does not match the hash", async () => {
        const { tx } = await buildConditionTx({ wrongPreimage: true });
        const result = verifyHashPreimage(tx, 0);

        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => /preimage|hash/i.test(e))).toBe(true);
    });

    it("should fail when condition witness is missing", async () => {
        const { tx } = await buildConditionTx({ noWitness: true });
        const result = verifyHashPreimage(tx, 0);

        expect(result.valid).toBe(false);
        expect(result.errors.some((e) => /witness|missing/i.test(e))).toBe(
            true
        );
    });
});

// ============================================================
// §: Full script satisfaction dispatch
// ============================================================

describe("verifyScriptSatisfaction", () => {
    const chainTip: ChainTip = { height: 1000, time: 1700000000 };

    it("should dispatch to CSV verifier for CSVMultisig scripts", async () => {
        const { tx } = await buildCSVTx({ csvBlocks: 144n });
        const result = verifyScriptSatisfaction(tx, 0, chainTip);

        expect(result.valid).toBe(true);
        expect(result.leafType).toBe("csv-multisig");
    });

    it("should dispatch to CLTV verifier for CLTVMultisig scripts", async () => {
        const { tx } = await buildCLTVTx({ locktime: 900n });
        const result = verifyScriptSatisfaction(tx, 0, chainTip);

        expect(result.valid).toBe(true);
        expect(result.leafType).toBe("cltv-multisig");
    });

    it("should dispatch to hash verifier for ConditionMultisig scripts", async () => {
        const { tx } = await buildConditionTx();
        const result = verifyScriptSatisfaction(tx, 0, chainTip);

        expect(result.valid).toBe(true);
        expect(result.leafType).toBe("condition-multisig");
    });

    it("should verify CSV + hash preimage for ConditionCSVMultisig", async () => {
        const { tx } = await buildConditionCSVTx();
        const result = verifyScriptSatisfaction(tx, 0, chainTip);

        expect(result.valid).toBe(true);
        expect(result.leafType).toBe("condition-csv-multisig");
    });

    it("should pass for plain Multisig (no extra conditions)", async () => {
        const { tx } = await buildMultisigTx();
        const result = verifyScriptSatisfaction(tx, 0, chainTip);

        expect(result.valid).toBe(true);
        expect(result.leafType).toBe("multisig");
    });

    it("should handle unknown tapscript type gracefully", async () => {
        const destScript = taprootOutputScript(
            await SingleKey.fromPrivateKey(
                randomPrivateKeyBytes()
            ).xOnlyPublicKey()
        );
        const tx = new ArkTransaction();
        // Create an input with a non-decodable tapLeafScript
        tx.addInput({
            txid: new Uint8Array(32).fill(0x01),
            index: 0,
            witnessUtxo: { script: destScript, amount: 10_000n },
        });
        tx.addOutput({ script: destScript, amount: 10_000n });

        const result = verifyScriptSatisfaction(tx, 0, chainTip);

        // Should not crash, should report the issue
        expect(result.valid).toBe(false);
        expect(result.errors.length).toBeGreaterThan(0);
    });
});

// ============================================================
// Test helpers
// ============================================================

function taprootOutputScript(xOnlyKey: Uint8Array): Uint8Array {
    const script = new Uint8Array(34);
    script[0] = 0x51;
    script[1] = 0x20;
    script.set(xOnlyKey, 2);
    return script;
}

function csvSequence(timelock: {
    value: bigint;
    type: "blocks" | "seconds";
}): number {
    return bip68.encode(
        timelock.type === "blocks"
            ? { blocks: Number(timelock.value) }
            : { seconds: Number(timelock.value) }
    );
}

async function buildCSVTx(
    opts: {
        csvBlocks?: bigint;
        csvSeconds?: bigint;
        sequenceOverride?: number;
    } = {}
) {
    const key = SingleKey.fromPrivateKey(randomPrivateKeyBytes());
    const pub = await key.xOnlyPublicKey();

    const timelock = opts.csvSeconds
        ? { value: opts.csvSeconds, type: "seconds" as const }
        : { value: opts.csvBlocks ?? 144n, type: "blocks" as const };

    const csvScript = CSVMultisigTapscript.encode({
        timelock,
        pubkeys: [pub],
    });
    const vtxoScript = new VtxoScript([csvScript.script]);

    const destScript = taprootOutputScript(
        await SingleKey.fromPrivateKey(randomPrivateKeyBytes()).xOnlyPublicKey()
    );

    // Use correct BIP-68 sequence unless overridden
    const sequence =
        opts.sequenceOverride !== undefined
            ? opts.sequenceOverride
            : csvSequence(timelock);

    const tx = new ArkTransaction();
    tx.addInput({
        txid: new Uint8Array(32).fill(0x01),
        index: 0,
        witnessUtxo: { script: vtxoScript.pkScript, amount: 10_000n },
        tapLeafScript: [vtxoScript.leaves[0]],
        sequence,
    });
    tx.addOutput({ script: destScript, amount: 10_000n });

    return { tx, key, pub };
}

async function buildCLTVTx(
    opts: {
        locktime: bigint;
        nLockTimeOverride?: number;
        disableLocktime?: boolean;
    } = { locktime: 900n }
) {
    const key = SingleKey.fromPrivateKey(randomPrivateKeyBytes());
    const pub = await key.xOnlyPublicKey();

    const cltvScript = CLTVMultisigTapscript.encode({
        absoluteTimelock: opts.locktime,
        pubkeys: [pub],
    });
    const vtxoScript = new VtxoScript([cltvScript.script]);

    const destScript = taprootOutputScript(
        await SingleKey.fromPrivateKey(randomPrivateKeyBytes()).xOnlyPublicKey()
    );

    const lockTime =
        opts.nLockTimeOverride !== undefined
            ? opts.nLockTimeOverride
            : Number(opts.locktime);

    const tx = new ArkTransaction({ lockTime });
    tx.addInput({
        txid: new Uint8Array(32).fill(0x01),
        index: 0,
        witnessUtxo: { script: vtxoScript.pkScript, amount: 10_000n },
        tapLeafScript: [vtxoScript.leaves[0]],
        sequence: opts.disableLocktime ? 0xffffffff : 0xfffffffe,
    });
    tx.addOutput({ script: destScript, amount: 10_000n });

    return { tx, key, pub };
}

async function buildConditionTx(
    opts: {
        wrongPreimage?: boolean;
        noWitness?: boolean;
    } = {}
) {
    const key = SingleKey.fromPrivateKey(randomPrivateKeyBytes());
    const pub = await key.xOnlyPublicKey();
    const serverKey = SingleKey.fromPrivateKey(randomPrivateKeyBytes());
    const serverPub = await serverKey.xOnlyPublicKey();

    const preimage = new Uint8Array(32);
    crypto.getRandomValues(preimage);
    const preimageHash = hash160(preimage);

    const conditionScript = Script.encode(["HASH160", preimageHash, "EQUAL"]);
    const condMultisig = ConditionMultisigTapscript.encode({
        conditionScript,
        pubkeys: [pub, serverPub],
    });
    const vtxoScript = new VtxoScript([condMultisig.script]);

    const destScript = taprootOutputScript(
        await SingleKey.fromPrivateKey(randomPrivateKeyBytes()).xOnlyPublicKey()
    );

    const tx = new ArkTransaction();
    tx.addInput({
        txid: new Uint8Array(32).fill(0x01),
        index: 0,
        witnessUtxo: { script: vtxoScript.pkScript, amount: 10_000n },
        tapLeafScript: [vtxoScript.leaves[0]],
    });
    tx.addOutput({ script: destScript, amount: 10_000n });

    if (!opts.noWitness) {
        const witnessPreimage = opts.wrongPreimage
            ? new Uint8Array(32).fill(0xff)
            : preimage;
        setArkPsbtField(tx, 0, ConditionWitness, [witnessPreimage]);
    }

    return { tx, key, pub, preimage, preimageHash };
}

async function buildConditionCSVTx() {
    const key = SingleKey.fromPrivateKey(randomPrivateKeyBytes());
    const pub = await key.xOnlyPublicKey();

    const preimage = new Uint8Array(32);
    crypto.getRandomValues(preimage);
    const preimageHash = hash160(preimage);

    const timelock = { value: 144n, type: "blocks" as const };
    const conditionScript = Script.encode(["HASH160", preimageHash, "EQUAL"]);
    const condCSV = ConditionCSVMultisigTapscript.encode({
        conditionScript,
        timelock,
        pubkeys: [pub],
    });
    const vtxoScript = new VtxoScript([condCSV.script]);

    const destScript = taprootOutputScript(
        await SingleKey.fromPrivateKey(randomPrivateKeyBytes()).xOnlyPublicKey()
    );

    const tx = new ArkTransaction();
    tx.addInput({
        txid: new Uint8Array(32).fill(0x01),
        index: 0,
        witnessUtxo: { script: vtxoScript.pkScript, amount: 10_000n },
        tapLeafScript: [vtxoScript.leaves[0]],
        sequence: csvSequence(timelock),
    });
    tx.addOutput({ script: destScript, amount: 10_000n });

    setArkPsbtField(tx, 0, ConditionWitness, [preimage]);

    return { tx, key, pub, preimage, preimageHash };
}

async function buildMultisigTx() {
    const key = SingleKey.fromPrivateKey(randomPrivateKeyBytes());
    const pub = await key.xOnlyPublicKey();

    const multisig = MultisigTapscript.encode({
        pubkeys: [pub],
        type: MultisigTapscript.MultisigType.CHECKSIG,
    });
    const vtxoScript = new VtxoScript([multisig.script]);

    const destScript = taprootOutputScript(
        await SingleKey.fromPrivateKey(randomPrivateKeyBytes()).xOnlyPublicKey()
    );

    const tx = new ArkTransaction();
    tx.addInput({
        txid: new Uint8Array(32).fill(0x01),
        index: 0,
        witnessUtxo: { script: vtxoScript.pkScript, amount: 10_000n },
        tapLeafScript: [vtxoScript.leaves[0]],
    });
    tx.addOutput({ script: destScript, amount: 10_000n });

    return { tx, key, pub };
}
