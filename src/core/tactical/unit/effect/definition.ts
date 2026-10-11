import type { BattleState } from "../../battle/execution/context.js";
import type { Unit } from "../unit.js";
import type { Effect, Ref } from "./effect.js";

export interface Context<S extends object, H extends object = object> {
    readonly battle: BattleState;
    readonly tick: number;
    readonly ref: Ref;
    readonly unit: Unit & H;
    readonly self: Effect<S, H>;
    setState(next: S | ((current: S) => S)): void;
    end(reason?: string): void;
}

export interface EndContext<S extends object, H extends object = object> extends Context<S, H> {
    readonly reason: string;
}

export interface Definition<S extends object, H extends object = object> {
    readonly id: string;
    readonly initialize: () => S;
    readonly onApply?: (context: Context<S, H>) => void;
    readonly onEnable?: (context: Context<S, H>) => void;
    readonly onDisable?: (context: Context<S, H>) => void;
    readonly onTick?: (context: Context<S, H>) => void;
    readonly onEnd?: (context: EndContext<S, H>) => void;
}
