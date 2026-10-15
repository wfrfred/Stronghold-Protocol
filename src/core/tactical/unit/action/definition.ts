import type { Ref } from "../../../common/ref.js";
import type { State as BattleState, Result } from "../../battle/state.js";
import type { Unit } from "../unit.js";
import type { Action as ActionCapability } from "../capability/action/capability.js";
import type { Action } from "./action.js";

export type Id = string;

export type End =
    { readonly type: "FINISHED" } | { readonly type: "CANCELLED"; readonly reason: string };

export interface Definition<S extends object = object> {
    readonly id: Id;
    readonly intervalTicks: number;
    readonly speed: number;
    readonly start: (battle: BattleState, source: Ref<Unit & ActionCapability>) => Result<S | null>;
    readonly step: (battle: BattleState, self: Action<S>) => Result<boolean>;
    readonly onEnd?: (battle: BattleState, self: Action<S>, end: End) => BattleState;
}
