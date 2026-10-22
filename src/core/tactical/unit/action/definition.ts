import type { Ref } from "../../../common/ref.js";
import type { State as BattleState, Result } from "../../battle/state.js";
import type { Unit } from "../unit.js";
import type { Action as ActionCapability } from "../capability/action/capability.js";
import type { Action } from "./action.js";
import type { State } from "./state.js";

export type Id = string;

export type End =
    { readonly type: "FINISHED" } | { readonly type: "CANCELLED"; readonly reason: string };

export interface View {
    readonly id: Id;
    readonly intervalTicks: number;
    readonly speed: number;
}

export interface Definition<P extends object = object, E extends object = object> extends View {
    readonly initialize: (battle: BattleState) => Result<P>;
    readonly start: (
        battle: BattleState,
        source: Ref<Unit & ActionCapability>,
        self: State<P, E>,
    ) => Result<E | null>;
    readonly step: (battle: BattleState, self: Action<P, E>) => Result<boolean>;
    readonly onEnd?: (battle: BattleState, self: Action<P, E>, end: End) => BattleState;
}
