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

export { collectExitData, validateExitData } from "./exitDataStore";
export type { ExitData, ExitDataRepository } from "./exitDataStore";

export { ExitDataStore } from "./exitDataRepository";

export {
    buildExitDataForVtxo,
    buildExitDataForVtxos,
    syncExitData,
} from "./exitDataSync";

export { sovereignExit, canSovereignExit } from "./sovereignExit";
export type {
    SovereignExitStep,
    SovereignExitResult,
    SovereignExitOptions,
} from "./sovereignExit";

export { buildVtxoDAG, renderDAGAscii } from "./dagVisualizer";
export type { DAGNode, DAGEdge, VtxoDAG } from "./dagVisualizer";
