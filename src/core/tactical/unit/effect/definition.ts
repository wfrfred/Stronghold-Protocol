import type { State as BattleState } from "../../battle/state.js";
import type { Unit } from "../unit.js";
import type { Effect } from "./effect.js";
import type { Ref } from "../../../common/ref.js";

export interface Group {
    readonly id: string;
    readonly priority: number;
}

export interface Context<S extends object, H extends object = object> {
    readonly tick: number;
    readonly ref: Ref<Effect<S, H>>;
    readonly unit: Unit & H;
    readonly self: Effect<S, H>;
}

export interface EndContext<S extends object, H extends object = object> extends Context<S, H> {
    readonly reason: string;
}

export interface Definition<S extends object, H extends object = object> {
    readonly id: string;
    readonly group?: Group;
    readonly initialize: () => S;
    readonly onInstall?: (state: BattleState, context: Context<S, H>) => BattleState;
    readonly onEnable?: (state: BattleState, context: Context<S, H>) => BattleState;
    readonly onDisable?: (state: BattleState, context: Context<S, H>) => BattleState;
    readonly onTick?: (state: BattleState, context: Context<S, H>) => BattleState;
    readonly onEnd?: (state: BattleState, context: EndContext<S, H>) => BattleState;
}
