import type { UnitId } from "../../unit/unit.js";
import type { HookCandidates } from "../../unit/capability/vitality/hook.js";

export interface CallContext {
    readonly vitalitySnapshots?: ReadonlyMap<UnitId, HookCandidates>;
}

export const emptyCall: CallContext = {};
