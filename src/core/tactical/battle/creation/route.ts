import { assertNonnegativeSafeInteger } from "../../../common/assert.js";
import {
    createTilePosition,
    createWorldOffset,
    type TilePosition,
    type WorldOffset,
} from "../../geometry/coordinate.js";
import type { MotionMode } from "../../battlefield/navigation/state.js";
import type {
    Checkpoint as RouteCheckpoint,
    Definition,
} from "../../unit/capability/route/capability.js";

export interface MoveTarget {
    readonly position: TilePosition;
    readonly reachOffset: WorldOffset;
}

export type Checkpoint =
    | { readonly type: "MOVE" | "PATROL_MOVE"; readonly target: MoveTarget }
    | { readonly type: "WAIT_FOR_TICKS"; readonly durationTicks: number }
    | { readonly type: "WAIT_FOR_PLAY_TICK"; readonly targetPlayTick: number }
    | {
          readonly type: "WAIT_CURRENT_FRAGMENT_TICKS" | "WAIT_CURRENT_WAVE_TICKS";
          readonly targetElapsedTicks: number;
      }
    | {
          readonly type: "APPEAR_AT_POS";
          readonly position: TilePosition;
          readonly reachOffset: WorldOffset;
      }
    | { readonly type: "DISAPPEAR" | "ALERT" };

export interface Input {
    readonly pathMotionMode: MotionMode;
    readonly startPosition: TilePosition;
    readonly endPosition: TilePosition;
    readonly spawnOffset: WorldOffset;
    readonly spawnRandomRange: WorldOffset;
    readonly checkpoints: readonly Checkpoint[];
    readonly visitEveryCheckPoint: boolean;
}

export interface Timing {
    readonly waveStartedAtTick: number;
    readonly fragmentStartedAtTick: number;
}

export function createTiming(timing: Timing): Timing {
    assertNonnegativeSafeInteger(timing.waveStartedAtTick, "waveStartedAtTick");
    assertNonnegativeSafeInteger(timing.fragmentStartedAtTick, "fragmentStartedAtTick");

    return Object.freeze({ ...timing });
}

function copyCheckpoint(checkpoint: Checkpoint): Checkpoint {
    switch (checkpoint.type) {
        case "MOVE":
        case "PATROL_MOVE":
            return Object.freeze({
                type: checkpoint.type,
                target: Object.freeze({
                    position: createTilePosition(...checkpoint.target.position),
                    reachOffset: createWorldOffset(...checkpoint.target.reachOffset),
                }),
            });

        case "WAIT_FOR_TICKS":
            assertNonnegativeSafeInteger(checkpoint.durationTicks, "durationTicks");

            return Object.freeze({ ...checkpoint });

        case "WAIT_FOR_PLAY_TICK":
            assertNonnegativeSafeInteger(checkpoint.targetPlayTick, "targetPlayTick");

            return Object.freeze({ ...checkpoint });

        case "WAIT_CURRENT_FRAGMENT_TICKS":
        case "WAIT_CURRENT_WAVE_TICKS":
            assertNonnegativeSafeInteger(checkpoint.targetElapsedTicks, "targetElapsedTicks");

            return Object.freeze({ ...checkpoint });

        case "APPEAR_AT_POS":
            return Object.freeze({
                type: checkpoint.type,
                position: createTilePosition(...checkpoint.position),
                reachOffset: createWorldOffset(...checkpoint.reachOffset),
            });

        case "DISAPPEAR":
        case "ALERT":
            return Object.freeze({ type: checkpoint.type });
    }
}

export function createInput(input: Input): Input {
    const checkpoints: Checkpoint[] = [];

    for (let index = 0; index < input.checkpoints.length; index++) {
        if (!Object.hasOwn(input.checkpoints, index)) {
            throw new TypeError("route checkpoints must be dense");
        }

        checkpoints.push(copyCheckpoint(input.checkpoints[index]!));
    }

    return Object.freeze({
        pathMotionMode: input.pathMotionMode,
        startPosition: createTilePosition(...input.startPosition),
        endPosition: createTilePosition(...input.endPosition),
        spawnOffset: createWorldOffset(...input.spawnOffset),
        spawnRandomRange: createWorldOffset(...input.spawnRandomRange),
        checkpoints: Object.freeze(checkpoints),
        visitEveryCheckPoint: input.visitEveryCheckPoint,
    });
}

function deadline(start: number, elapsed: number): number {
    const tick = start + elapsed;
    assertNonnegativeSafeInteger(tick, "route wait deadline");

    return tick;
}

export function normalize(
    input: Input,
    timing: Timing,
    offset: WorldOffset,
    alwaysCheckCurrentPoint: boolean,
): Definition {
    const checkpoints: RouteCheckpoint[] = [];
    const indices: number[] = [];

    for (let index = 0; index < input.checkpoints.length; index++) {
        const checkpoint = input.checkpoints[index]!;
        indices.push(checkpoints.length);

        switch (checkpoint.type) {
            case "MOVE":
            case "PATROL_MOVE": {
                checkpoints.push({
                    type: "MOVE",
                    position: checkpoint.target.position,
                    offset: checkpoint.target.reachOffset,
                });

                if (
                    checkpoint.type === "PATROL_MOVE" &&
                    (index + 1 === input.checkpoints.length ||
                        input.checkpoints[index + 1]!.type === "MOVE")
                ) {
                    let start = index;

                    while (start > 0 && input.checkpoints[start - 1]!.type !== "MOVE") {
                        start--;
                    }
                    if (start < index) {
                        checkpoints.push({ type: "GOTO", index: indices[start]! });
                    }
                }

                break;
            }

            case "WAIT_FOR_TICKS":
                checkpoints.push({ type: "WAIT", tick: checkpoint.durationTicks });
                break;

            case "WAIT_FOR_PLAY_TICK":
                checkpoints.push({ type: "WAIT_UNTIL", tick: checkpoint.targetPlayTick });
                break;

            case "WAIT_CURRENT_FRAGMENT_TICKS":
                checkpoints.push({
                    type: "WAIT_UNTIL",
                    tick: deadline(timing.fragmentStartedAtTick, checkpoint.targetElapsedTicks),
                });
                break;

            case "WAIT_CURRENT_WAVE_TICKS":
                checkpoints.push({
                    type: "WAIT_UNTIL",
                    tick: deadline(timing.waveStartedAtTick, checkpoint.targetElapsedTicks),
                });
                break;

            case "APPEAR_AT_POS":
                checkpoints.push({
                    type: checkpoint.type,
                    position: checkpoint.position,
                    offset: checkpoint.reachOffset,
                });
                break;

            case "DISAPPEAR":
            case "ALERT":
                checkpoints.push({ type: checkpoint.type });
                break;
        }
    }

    return Object.freeze({
        pathMotionMode: input.pathMotionMode,
        startPosition: input.startPosition,
        endPosition: input.endPosition,
        offset: createWorldOffset(...offset),
        checkpoints: Object.freeze(checkpoints.map((checkpoint) => Object.freeze(checkpoint))),
        requireAllCheckpoints: input.visitEveryCheckPoint,
        alwaysCheckCurrentPoint,
    });
}
