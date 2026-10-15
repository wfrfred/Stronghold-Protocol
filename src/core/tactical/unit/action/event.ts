import type { Id as UnitId } from "../unit.js";
import type { Id } from "./action.js";

export type Signal = {
    readonly executionId: Id;
    readonly sourceUnitId: UnitId;
    readonly tick: number;
} & (
    | { readonly type: "ACTION_RELEASED"; readonly markerId: string }
    | { readonly type: "ACTION_FINISHED" }
    | { readonly type: "ACTION_CANCELLED"; readonly reason: string }
);
