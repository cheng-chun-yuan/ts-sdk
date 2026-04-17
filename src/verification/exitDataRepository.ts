import type { Outpoint } from "../wallet";
import type { StorageAdapter } from "../storage";
import type { ExitData, ExitDataRepository } from "./exitDataStore";

type StoredIndex = string[];

/**
 * Persist ExitData through any StorageAdapter implementation.
 *
 * This class is environment-agnostic: it takes a StorageAdapter
 * instance and does not import the Node / browser / React Native
 * adapters directly. Callers construct the right adapter for their
 * environment (e.g. `new FileSystemStorageAdapter(dir)` on Node) and
 * pass it here. Keeping this file free of environment-specific imports
 * prevents bundlers from pulling `fs` into browser builds.
 */
export class StorageAdapterExitDataRepository implements ExitDataRepository {
    constructor(
        private readonly storage: StorageAdapter,
        private readonly namespace: string = "exit-data"
    ) {}

    async saveExitData(data: ExitData): Promise<void> {
        const key = this.entryKey(data.vtxoOutpoint);
        await this.storage.setItem(key, JSON.stringify(data));
        const index = await this.getIndex();
        if (!index.includes(key)) {
            index.push(key);
            await this.setIndex(index);
        }
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
        const index = await this.getIndex();
        await this.storage.removeItem(key);
        await this.setIndex(index.filter((entry) => entry !== key));
    }

    async clear(): Promise<void> {
        const index = await this.getIndex();
        await Promise.all(index.map((key) => this.storage.removeItem(key)));
        await this.storage.removeItem(this.indexKey());
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
