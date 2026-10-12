import type { BattleState } from "../../battle/state.js";
import type { CallContext } from "../../battle/execution/call.js";
import type { Unit } from "../unit.js";
import type { Effect, Group, Ref } from "./effect.js";

export interface Context<S extends object, H extends object = object> {
    readonly tick: number;
    readonly ref: Ref;
    readonly unit: Unit & H;
    readonly self: Effect<S, H>;
    readonly call: CallContext;
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
