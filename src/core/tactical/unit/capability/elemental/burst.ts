import type { Identified, Ref } from "../../../../common/ref.js";
import type { State as BattleState } from "../../../battle/state.js";
import type { Unit } from "../../unit.js";
import type { Elemental, Type } from "./capability.js";

export type Id = number;

export type Status = "ACTIVE" | "ENDING";

export type End =
    { readonly type: "FINISHED" } | { readonly type: "CANCELLED"; readonly reason: string };

export interface Definition {
    readonly durationTicks: number;
    readonly onStart: (battle: BattleState, self: Burst) => BattleState;
    readonly onEnd?: (battle: BattleState, self: Burst, end: End) => BattleState;
}

export interface Burst extends Identified<{
    readonly host: Ref<Unit & Elemental>;
    readonly id: Id;
}> {
    readonly host: Ref<Unit & Elemental>;
    readonly id: Id;
    readonly type: Type;
    readonly source: Ref<Unit> | null;
    readonly startedAtTick: number;
    readonly status: Status;
    readonly remainingTicks: number;
}

export function ref(self: Burst): Ref<Burst> {
    return { host: self.host, id: self.id } as Ref<Burst>;
}
