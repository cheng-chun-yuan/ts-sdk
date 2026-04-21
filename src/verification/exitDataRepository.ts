import type { Outpoint } from "../wallet";
import type { StorageAdapter } from "../storage";
import type { ExitData, ExitDataRepository } from "./exitDataStore";

type StoredIndex = string[];

/**
 * Persist ExitData through any StorageAdapter implementation.
 *
 * Environment-agnostic: takes a StorageAdapter instance and does not
 * import Node / browser / React Native adapters directly, so bundlers
 * do not pull `fs` into browser builds. Tests compose it with
 * `InMemoryStorageAdapter` from `../storage`.
 */
export class ExitDataStore implements ExitDataRepository {
    // Serializes read-modify-write of the namespace index so concurrent
    // saveExitData / deleteExitData calls (fanned out by syncExitData via
    // Promise.allSettled) can't stomp on each other's appends.
    private indexLock: Promise<void> = Promise.resolve();

    constructor(
        private readonly storage: StorageAdapter,
        private readonly namespace: string = "exit-data"
    ) {}

    async saveExitData(data: ExitData): Promise<void> {
        const key = this.entryKey(data.vtxoOutpoint);
        await this.storage.setItem(key, JSON.stringify(data));
        await this.mutateIndex((index) =>
            index.includes(key) ? index : [...index, key]
        );
    }

    async getExitData(outpoint: Outpoint): Promise<ExitData | null> {
        const raw = await this.storage.getItem(this.entryKey(outpoint));
        return raw ? (JSON.parse(raw) as ExitData) : null;
    }

    async getAllExitData(): Promise<ExitData[]> {
        const index = await this.getIndex();
        const all = await Promise.all(
            index.map(async (key) => {
                const raw = await this.storage.getItem(key);
                return raw ? (JSON.parse(raw) as ExitData) : null;
            })
        );
        return all.filter((entry): entry is ExitData => entry !== null);
    }

    async deleteExitData(outpoint: Outpoint): Promise<void> {
        const key = this.entryKey(outpoint);
        await this.storage.removeItem(key);
        await this.mutateIndex((index) =>
            index.filter((entry) => entry !== key)
        );
    }

    async clear(): Promise<void> {
        await this.mutateIndex(async (index) => {
            await Promise.all(index.map((key) => this.storage.removeItem(key)));
            await this.storage.removeItem(this.indexKey());
            return [];
        });
    }

    private mutateIndex(
        mutator: (index: StoredIndex) => StoredIndex | Promise<StoredIndex>
    ): Promise<void> {
        const next = this.indexLock.then(async () => {
            const current = await this.getIndex();
            const updated = await mutator(current);
            await this.setIndex(updated);
        });
        // Swallow rejections on the chain itself so one failed mutation
        // doesn't permanently poison future mutations. The awaited promise
        // still surfaces the error to the caller.
        this.indexLock = next.catch(() => undefined);
        return next;
    }

    private entryKey(outpoint: Outpoint): string {
        return `${this.namespace}:${outpoint.txid}:${outpoint.vout}`;
    }

    private indexKey(): string {
        return `${this.namespace}:index`;
    }

    private async getIndex(): Promise<StoredIndex> {
        const raw = await this.storage.getItem(this.indexKey());
        return raw ? (JSON.parse(raw) as StoredIndex) : [];
    }

    private async setIndex(index: StoredIndex): Promise<void> {
        await this.storage.setItem(this.indexKey(), JSON.stringify(index));
    }
}
