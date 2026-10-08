import type { Rng, Seed } from "../../../../../common/rng.js";
import { assertNonnegativeSafeInteger } from "../../../../../common/assert.js";
import {
    createWorldOffset,
    Tile,
    World,
    type WorldPosition,
} from "../../../../geometry/coordinate.js";
import {
    createNavigationRequest,
    type NavigationOptions,
    type NavigationRequest,
    type NavigationRequestId,
} from "../../../../battlefield/navigation/request.js";
import type { RouteCheckpoint, RouteDefinition, RouteMoveTarget } from "./definition.js";
import type { RouteMoveProgress, RouteProgress, RouteState } from "./state.js";

const ROUTE_TRANSITIONS_PER_TICK = 128;

export interface RouteExecutionContext {
    readonly tick: number;
    readonly rng: Rng;
    readonly nextNavigationRequestId: () => NavigationRequestId;
    readonly tryEnterCheckpoint: () => boolean;
}

export interface RouteExecution extends RouteExecutionContext {
    state(): {
        readonly rngState: Seed;
        readonly nextNavigationRequestId: NavigationRequestId;
    };
}

export function createRouteExecution(
    rng: Rng,
    initialNextNavigationRequestId: NavigationRequestId,
    tick: number,
    transitionBudget = ROUTE_TRANSITIONS_PER_TICK,
): RouteExecution {
    assertNonnegativeSafeInteger(transitionBudget, "route transition budget");
    let nextNavigationRequestId = initialNextNavigationRequestId;
    let remainingTransitions = transitionBudget;

    return {
        tick,
        rng,
        nextNavigationRequestId() {
            const id = nextNavigationRequestId;
            const next = id + 1;

            if (!Number.isSafeInteger(id) || id < 0 || !Number.isSafeInteger(next)) {
                throw new RangeError("navigation request identity overflow");
            }

            nextNavigationRequestId = next;

            return id;
        },
        tryEnterCheckpoint() {
            if (remainingTransitions === 0) {
                return false;
            }

            remainingTransitions--;

            return true;
        },
        state() {
            return { rngState: rng.state(), nextNavigationRequestId };
        },
    };
}

export interface RouteTransition {
    readonly state: RouteState;
    readonly request?: NavigationRequest;
    readonly signals: readonly RouteSignal[];
}

export type RouteSignal =
    | { readonly type: "DISAPPEAR" }
    | { readonly type: "APPEAR_AT_POS"; readonly position: WorldPosition }
    | { readonly type: "ALERT" };

function withProgress(state: RouteState, progress: RouteProgress): RouteState {
    return {
        definition: state.definition,
        timing: state.timing,
        alwaysCheckCurrentPoint: state.alwaysCheckCurrentPoint,
        progress,
    };
}

function moveProgress(request: NavigationRequest): RouteMoveProgress {
    return {
        type: "MOVE",
        goal: request.goal,
    };
}

export function routeNavigationOptions(definition: RouteDefinition): NavigationOptions {
    return {
        allowDiagonalMove: definition.allowDiagonalMove,
        visitEveryTileCenter: definition.visitEveryTileCenter,
        visitEveryNodeCenter: definition.visitEveryNodeCenter,
        visitEveryNodeStably: definition.checkpoints.length === 0,
    };
}

function navigationRequest(
    state: RouteState,
    target: RouteMoveTarget | null,
    position: WorldPosition,
    context: RouteExecutionContext,
): NavigationRequest {
    const definition = state.definition;

    return createNavigationRequest({
        id: context.nextNavigationRequestId(),
        targetTile: target?.position ?? definition.endPosition,
        goal: {
            position,
            reachDistance: target === null ? 0.05 : Math.max(target.reachDistance, 0.05),
        },
        options: routeNavigationOptions(definition),
        arrivalRule: target === null ? "TARGET_TILE_AND_DISTANCE" : "DISTANCE",
    });
}

function resolveMovePosition(
    target: RouteMoveTarget,
    rng: Rng,
    addFixedOffset: boolean,
): WorldPosition {
    const center = Tile.center(target.position);

    if (!target.randomizeReachOffset) {
        return World.translate(center, target.reachOffset);
    }

    const origin = addFixedOffset ? World.translate(center, target.reachOffset) : center;

    for (let axis = 0; axis < 2; axis++) {
        const range = target.reachOffset[axis]!;
        const coordinate = origin[axis]!;

        if (
            !Number.isFinite(range * 2) ||
            !Number.isFinite(coordinate - range) ||
            !Number.isFinite(coordinate + range)
        ) {
            throw new RangeError("route move bounds must be finite");
        }
    }

    const [rangeX, rangeY] = target.reachOffset;
    const offset = createWorldOffset(
        -rangeX + rng.next() * (2 * rangeX),
        -rangeY + rng.next() * (2 * rangeY),
    );

    return World.translate(origin, offset);
}

function targetTick(startedAtTick: number, elapsedTicks: number): number {
    const target = startedAtTick + elapsedTicks;

    if (!Number.isSafeInteger(target)) {
        throw new RangeError("route wait target tick overflow");
    }

    return target;
}

function remainingWaitTicks(state: RouteState, checkpoint: RouteCheckpoint, tick: number): number {
    switch (checkpoint.type) {
        case "WAIT_FOR_TICKS":
            return checkpoint.durationTicks;

        case "WAIT_FOR_PLAY_TICK":
            return Math.max(0, checkpoint.targetPlayTick - tick);

        case "WAIT_CURRENT_FRAGMENT_TICKS":
            return Math.max(
                0,
                targetTick(state.timing.fragmentStartedAtTick, checkpoint.targetElapsedTicks) -
                    tick,
            );

        case "WAIT_CURRENT_WAVE_TICKS":
            return Math.max(
                0,
                targetTick(state.timing.waveStartedAtTick, checkpoint.targetElapsedTicks) - tick,
            );

        case "ALERT":
        case "APPEAR_AT_POS":
        case "DISAPPEAR":
        case "MAP_OFFSET_MOVE":
        case "MOVE":
        case "PATROL_MOVE":
        default:
            throw new Error("route checkpoint is not a wait");
    }
}

export function enterRoute(state: RouteState, context: RouteExecutionContext): RouteTransition {
    const progress = state.progress;

    if (progress.phase !== "CHECKPOINTS" || progress.checkpoint.type !== "NOT_ENTERED") {
        return { state, signals: [] };
    }
    if (!context.tryEnterCheckpoint()) {
        return { state, signals: [] };
    }
    if (progress.checkpointIndex >= state.definition.checkpoints.length) {
        const request = navigationRequest(
            state,
            null,
            Tile.center(state.definition.endPosition),
            context,
        );

        return {
            state: withProgress(state, { phase: "END", move: moveProgress(request) }),
            request,
            signals: [],
        };
    }

    const checkpoint = state.definition.checkpoints[progress.checkpointIndex]!;

    switch (checkpoint.type) {
        case "MOVE":
        case "PATROL_MOVE":
        case "MAP_OFFSET_MOVE": {
            const position = resolveMovePosition(
                checkpoint.target,
                context.rng,
                checkpoint.type === "MAP_OFFSET_MOVE",
            );
            const request = navigationRequest(state, checkpoint.target, position, context);

            return {
                state: withProgress(state, {
                    phase: "CHECKPOINTS",
                    checkpointIndex: progress.checkpointIndex,
                    checkpoint: moveProgress(request),
                }),
                request,
                signals: [],
            };
        }

        case "WAIT_FOR_TICKS":
        case "WAIT_FOR_PLAY_TICK":
        case "WAIT_CURRENT_FRAGMENT_TICKS":
        case "WAIT_CURRENT_WAVE_TICKS":
            return {
                state: withProgress(state, {
                    phase: "CHECKPOINTS",
                    checkpointIndex: progress.checkpointIndex,
                    checkpoint: {
                        type: "WAIT",
                        remainingTicks: remainingWaitTicks(state, checkpoint, context.tick),
                    },
                }),
                signals: [],
            };

        case "DISAPPEAR":
        case "APPEAR_AT_POS":
        case "ALERT":
            return {
                state: withProgress(state, {
                    phase: "CHECKPOINTS",
                    checkpointIndex: progress.checkpointIndex,
                    checkpoint: { type: "ENTERED" },
                }),
                signals: [
                    checkpoint.type === "APPEAR_AT_POS"
                        ? {
                              type: checkpoint.type,
                              position: World.translate(
                                  Tile.center(checkpoint.position),
                                  checkpoint.reachOffset,
                              ),
                          }
                        : { type: checkpoint.type },
                ],
            };
    }
}

export function nextCheckpointIndex(definition: RouteDefinition, checkpointIndex: number): number {
    const checkpoints = definition.checkpoints;
    const nextIndex = checkpointIndex + 1;

    if (
        checkpoints[checkpointIndex]?.type !== "PATROL_MOVE" ||
        (nextIndex < checkpoints.length && checkpoints[nextIndex]!.type !== "MOVE")
    ) {
        return nextIndex;
    }

    let segmentStart = checkpointIndex;

    while (segmentStart > 0 && checkpoints[segmentStart - 1]!.type !== "MOVE") {
        segmentStart--;
    }

    return segmentStart < checkpointIndex ? segmentStart : nextIndex;
}

export function completeRoute(state: RouteState): RouteState {
    return state.progress.phase === "COMPLETED"
        ? state
        : withProgress(state, { phase: "COMPLETED" });
}

export function advanceRoute(state: RouteState, context: RouteExecutionContext): RouteTransition {
    const progress = state.progress;

    if (progress.phase === "COMPLETED") {
        return { state, signals: [] };
    }
    if (progress.phase === "END") {
        return { state: completeRoute(state), signals: [] };
    }
    if (progress.checkpoint.type === "NOT_ENTERED") {
        throw new Error("cannot advance a route checkpoint before entering it");
    }

    const nextIndex = nextCheckpointIndex(state.definition, progress.checkpointIndex);

    return enterRoute(
        withProgress(state, {
            phase: "CHECKPOINTS",
            checkpointIndex: nextIndex,
            checkpoint: { type: "NOT_ENTERED" },
        }),
        context,
    );
}

export function tickRouteWait(state: RouteState, tick: number): RouteState {
    const progress = state.progress;

    if (progress.phase !== "CHECKPOINTS" || progress.checkpoint.type !== "WAIT") {
        return state;
    }

    const checkpoint = state.definition.checkpoints[progress.checkpointIndex]!;
    const remainingTicks =
        checkpoint.type === "WAIT_FOR_TICKS"
            ? Math.max(0, progress.checkpoint.remainingTicks - 1)
            : remainingWaitTicks(state, checkpoint, tick);

    if (remainingTicks === progress.checkpoint.remainingTicks) {
        return state;
    }

    return withProgress(state, {
        phase: "CHECKPOINTS",
        checkpointIndex: progress.checkpointIndex,
        checkpoint: { type: "WAIT", remainingTicks },
    });
}
