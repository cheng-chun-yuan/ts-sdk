# Summary

This PR adds standalone client-side verification APIs for Ark VTXOs, script-path validation helpers, and sovereign unilateral-exit data storage/exit flow support.

The implementation is intentionally centered on standalone verification exports rather than expanding the core wallet API surface broadly. `Wallet` and `ExpoWallet` only add thin convenience wrappers for `verifyVtxo(...)` and `verifyAllVtxos(...)`.

# Scope

## Tier 1

- reconstruct and validate VTXO DAGs from leaf to commitment tx
- verify parent/child linkage
- verify signatures, cosigner aggregation, and unspendable internal keys
- verify onchain anchoring against a user-controlled Bitcoin backend
- validate checkpoint integration

## Tier 2

- verify taproot script tree structure
- verify CSV/CLTV constraints
- verify hash preimage conditions
- add Boltz-style swap verification helpers

## Tier 3

- collect and validate unilateral-exit data
- persist exit data through repository adapters
- sync exit data from wallet VTXO refreshes
- support sovereign exit using local exit data plus Bitcoin backend access
- support final CSV claim when local claim metadata is available

# API Additions

Top-level exports:

- `verifyVtxo(...)`
- `verifyAllVtxos(...)`
- `verifyOnchainAnchor(...)`
- `verifyCheckpointTransactions(...)`
- `verifyCheckpointTimelocks(...)`
- `verifyTreeSignatures(...)`
- `verifyCosignerKeys(...)`
- `verifyInternalKeysUnspendable(...)`
- `verifyTaprootScriptTree(...)`
- `verifyCSV(...)`
- `verifyCLTV(...)`
- `verifyHashPreimage(...)`
- `verifyScriptSatisfaction(...)`
- `verifyBoltzSwapPreimage(...)`
- `verifyBoltzSwapSatisfaction(...)`
- `collectExitData(...)`
- `validateExitData(...)`
- `buildExitDataForVtxo(...)`
- `buildExitDataForVtxos(...)`
- `syncExitData(...)`
- `canSovereignExit(...)`
- `sovereignExit(...)`

Repository/storage:

- `InMemoryExitDataRepository`
- `StorageAdapterExitDataRepository`
- `FileSystemExitDataRepository`
- `IndexedDBExitDataRepository`
- `AsyncStorageExitDataRepository`

Wallet convenience:

- `wallet.verifyVtxo(...)`
- `wallet.verifyAllVtxos(...)`

# Required Supporting Changes

- `OnchainProvider` now requires `getTxHex(txid)`
- tree validation no longer assumes the relevant parent spend is always input `0`
- wallet storage config optionally accepts `exitDataRepository`
- onchain incoming-funds notifications now emit confirmed boarding UTXOs only

# Non-goals

- no broad wallet API redesign
- no folder restructuring
- no unrelated refactors of existing production-ready flows

# Verification

Local:

- `pnpm exec tsc -p tsconfig.json --noEmit`

Live regtest:

- `pnpm test:integration-docker`
- result: `6` test files passed, `61` tests passed
