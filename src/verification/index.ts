export { verifyVtxo, verifyAllVtxos } from "./vtxoChainVerifier";
export type {
    VtxoVerificationResult,
    VtxoVerificationOptions,
    PartialChecks,
} from "./vtxoChainVerifier";

export {
    verifyTreeSignatures,
    verifyCosignerKeys,
    verifyInternalKeysUnspendable,
} from "./signatureVerifier";
export type {
    SignatureVerificationResult,
    CosignerKeyVerificationResult,
    InternalKeyVerificationResult,
} from "./signatureVerifier";

export { verifyOnchainAnchor } from "./onchainAnchorVerifier";
export type { AnchorVerification } from "./onchainAnchorVerifier";

export {
    verifyCheckpointTransactions,
    verifyCheckpointExpiry,
} from "./checkpointVerifier";
export type {
    CheckpointVerificationResult,
    CheckpointTimelockResult,
} from "./checkpointVerifier";

export {
    verifyTaprootScriptTree,
    verifyCSV,
    verifyCLTV,
    verifyHashPreimage,
    verifyScriptSatisfaction,
} from "./scriptVerifier";
export type {
    ScriptVerificationResult,
    ChainTip,
    ParentConfirmation,
} from "./scriptVerifier";
