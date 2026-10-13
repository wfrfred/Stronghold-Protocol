import type { Id } from "../../unit/unit.js";
import type { HookCandidates } from "../../unit/capability/vitality/hook.js";

export interface CallContext {
    readonly vitalitySnapshots?: ReadonlyMap<Id, HookCandidates>;
}

export const emptyCall: CallContext = {};
