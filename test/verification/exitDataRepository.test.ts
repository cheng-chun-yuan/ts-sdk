import { describe, expect, it } from "vitest";
import type { StorageAdapter } from "../../src/storage";
import { ExitDataStore } from "../../src/verification/exitDataRepository";
import type { ExitData } from "../../src/verification/exitDataStore";

class MemoryStorageAdapter implements StorageAdapter {
    private store = new Map<string, string>();

    async getItem(key: string): Promise<string | null> {
        return this.store.get(key) ?? null;
    }

    async setItem(key: string, value: string): Promise<void> {
        this.store.set(key, value);
    }

    async removeItem(key: string): Promise<void> {
        this.store.delete(key);
    }

    async clear(): Promise<void> {
        this.store.clear();
    }
}

describe("ExitDataStore", () => {
    it("saves and retrieves exit data through the adapter", async () => {
        const repo = new ExitDataStore(new MemoryStorageAdapter());
        const data = makeExitData();

        await repo.saveExitData(data);
        const retrieved = await repo.getExitData(data.vtxoOutpoint);

        expect(retrieved).not.toBeNull();
        expect(retrieved!.commitmentTxid).toBe(data.commitmentTxid);
    });

    it("lists all saved exit data entries", async () => {
        const repo = new ExitDataStore(new MemoryStorageAdapter());

        await repo.saveExitData(makeExitData("aa".repeat(32)));
        await repo.saveExitData(makeExitData("bb".repeat(32)));

        const all = await repo.getAllExitData();
        expect(all).toHaveLength(2);
    });

    it("deletes a single exit data entry", async () => {
        const repo = new ExitDataStore(new MemoryStorageAdapter());
        const data = makeExitData();
        await repo.saveExitData(data);

        await repo.deleteExitData(data.vtxoOutpoint);

        expect(await repo.getExitData(data.vtxoOutpoint)).toBeNull();
    });

    it("keeps the index consistent under concurrent saves", async () => {
        // Regression for bug_007: saveExitData / deleteExitData used to
        // perform a non-atomic read-modify-write on the namespace index.
        // syncExitData fans out saves via Promise.allSettled, so a
        // concurrent writer would overwrite siblings' appends and drop
        // entries from getAllExitData / clear.
        const repo = new ExitDataStore(new MemoryStorageAdapter());
        const entries = Array.from({ length: 10 }, (_, i) => {
            const hexByte = i.toString(16).padStart(2, "0");
            return makeExitData(hexByte.repeat(32));
        });

        await Promise.all(entries.map((e) => repo.saveExitData(e)));

        const all = await repo.getAllExitData();
        expect(all).toHaveLength(entries.length);
    });

    it("keeps the index consistent under concurrent saves and deletes", async () => {
        const repo = new ExitDataStore(new MemoryStorageAdapter());
        const entries = Array.from({ length: 6 }, (_, i) => {
            const hexByte = i.toString(16).padStart(2, "0");
            return makeExitData(hexByte.repeat(32));
        });
        await Promise.all(entries.map((e) => repo.saveExitData(e)));

        // Delete half in parallel.
        await Promise.all(
            entries.slice(0, 3).map((e) => repo.deleteExitData(e.vtxoOutpoint))
        );

        const remaining = await repo.getAllExitData();
        expect(remaining).toHaveLength(3);
        const txids = remaining.map((e) => e.vtxoOutpoint.txid).sort();
        expect(txids).toEqual(
            entries
                .slice(3)
                .map((e) => e.vtxoOutpoint.txid)
                .sort()
        );
    });
});

function makeExitData(txid: string = "aa".repeat(32)): ExitData {
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
                txid,
                type: "INDEXER_CHAINED_TX_TYPE_TREE" as any,
                expiresAt: "",
                spends: ["cc".repeat(32)],
            },
        ],
        virtualTxs: { [txid]: "base64psbt" },
        treeNodes: [{ txid, tx: "base64psbt", children: {} }],
        storedAt: Date.now(),
    };
}
