import { assert, assertNonnegativeSafeInteger } from "../../../../common/assert.js";
import type { State as BattleState, Result } from "../../../battle/state.js";
import type { MotionMode } from "../../../battlefield/navigation/state.js";
import {
    isTilePosition,
    isWorldPosition,
    type TilePosition,
    type WorldOffset,
} from "../../../geometry/coordinate.js";
import type { Unit } from "../../unit.js";

export interface Definition {
    readonly pathMotionMode: MotionMode;
    readonly startPosition: TilePosition;
    readonly endPosition: TilePosition;
    readonly offset: WorldOffset;
    readonly checkpoints: readonly Checkpoint[];
    readonly requireAllCheckpoints: boolean;
    readonly alwaysCheckCurrentPoint: boolean;
}

export type Checkpoint =
    | {
          readonly type: "MOVE";
          readonly position: TilePosition;
          readonly offset: WorldOffset;
      }
    | { readonly type: "WAIT"; readonly tick: number }
    | { readonly type: "WAIT_UNTIL"; readonly tick: number }
    | {
          readonly type: "APPEAR_AT_POS";
          readonly position: TilePosition;
          readonly offset: WorldOffset;
      }
    | { readonly type: "DISAPPEAR" }
    | { readonly type: "ALERT" }
    | { readonly type: "GOTO"; readonly index: number };

export type CheckpointState =
    | { readonly type: "PENDING" }
    | { readonly type: "MOVING" }
    | { readonly type: "WAITING"; readonly deadlineTick: number }
    | { readonly type: "CONSUMED" };

export type Phase =
    | {
          readonly type: "CHECKPOINT";
          readonly index: number;
          readonly checkpointState: CheckpointState;
      }
    | { readonly type: "END" }
    | { readonly type: "COMPLETED" };

export interface Progress {
    readonly definition: Definition;
    readonly phase: Phase;
}

export interface State {
    readonly main: Progress;
    readonly alternative: Progress | null;
}

export interface Route {
    readonly definition: { readonly route: Definition };
    readonly route: State;
}

export function hasRoute<U extends Unit>(unit: U): unit is U & Route {
    return "route" in unit && "route" in unit.definition;
}

export function initialize(battle: BattleState, definition: Definition): Result<State> {
    assert(isTilePosition(definition.startPosition), "invalid route start position", TypeError);
    assert(isTilePosition(definition.endPosition), "invalid route end position", TypeError);
    assert(isWorldPosition(definition.offset), "invalid route offset", TypeError);

    for (const checkpoint of definition.checkpoints) {
        if (checkpoint.type === "MOVE" || checkpoint.type === "APPEAR_AT_POS") {
            assert(isTilePosition(checkpoint.position), "invalid checkpoint position", TypeError);
            assert(isWorldPosition(checkpoint.offset), "invalid checkpoint offset", TypeError);
        } else if (checkpoint.type === "WAIT" || checkpoint.type === "WAIT_UNTIL") {
            assertNonnegativeSafeInteger(checkpoint.tick, "checkpoint tick");
        } else if (checkpoint.type === "GOTO") {
            assertNonnegativeSafeInteger(checkpoint.index, "checkpoint index");
            assert(
                checkpoint.index < definition.checkpoints.length,
                "checkpoint jump must identify an instruction",
                RangeError,
            );
        }
    }

    return {
        state: battle,
        value: {
            main: {
                definition,
                phase:
                    definition.checkpoints.length === 0
                        ? { type: "END" }
                        : { type: "CHECKPOINT", index: 0, checkpointState: { type: "PENDING" } },
            },
            alternative: null,
        },
    };
}
