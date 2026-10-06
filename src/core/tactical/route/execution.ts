import type { Rng, Seed } from "../../common/rng.js";
import { createWorldOffset, Tile, World } from "../geometry/coordinate.js";
import type { WorldPosition } from "../geometry/coordinate.js";
import { createNavigationRequest } from "../navigation/request.js";
import type { NavigationRequest, NavigationRequestId } from "../navigation/request.js";
import type { RouteCheckpoint, RouteDefinition, RouteMoveTarget } from "./definition.js";
import type { RouteMoveProgress, RouteProgress, RouteState } from "./state.js";

const MAX_PATROL_RESTARTS_PER_TICK = 51;

export interface RouteExecutionContext {
    readonly tick: number;
    readonly rng: Rng;
    readonly nextNavigationRequestId: () => NavigationRequestId;
    readonly tryRestartPatrol: (checkpointIndex: number) => boolean;
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
): RouteExecution {
    let nextNavigationRequestId = initialNextNavigationRequestId;
    const patrolRestarts = new Map<number, number>();
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
        tryRestartPatrol(checkpointIndex) {
            const count = patrolRestarts.get(checkpointIndex) ?? 0;
            if (count >= MAX_PATROL_RESTARTS_PER_TICK) return false;
            patrolRestarts.set(checkpointIndex, count + 1);
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
}

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
        navigationRequestId: request.id,
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
        options: {
            allowDiagonalMove: definition.allowDiagonalMove,
            visitEveryTileCenter: definition.visitEveryTileCenter,
            visitEveryNodeCenter: definition.visitEveryNodeCenter,
            visitEveryNodeStably: definition.checkpoints.length === 0,
        },
        arrivalRule: target === null ? "TARGET_TILE_AND_DISTANCE" : "DISTANCE",
    });
}

function resolveMovePosition(target: RouteMoveTarget, rng: Rng, addFixedOffset: boolean): WorldPosition {
    const center = Tile.center(target.position);
    if (!target.randomizeReachOffset) {
        return World.translate(center, target.reachOffset);
    }
    const origin = addFixedOffset ? World.translate(center, target.reachOffset) : center;
    for (let axis = 0; axis < 2; axis++) {
        const range = target.reachOffset[axis]!;
        const coordinate = origin[axis]!;
        if (!Number.isFinite(range * 2)
            || !Number.isFinite(coordinate - range)
            || !Number.isFinite(coordinate + range)) {
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
            return Math.max(0, targetTick(state.timing.fragmentStartedAtTick, checkpoint.targetElapsedTicks) - tick);
        case "WAIT_CURRENT_WAVE_TICKS":
            return Math.max(0, targetTick(state.timing.waveStartedAtTick, checkpoint.targetElapsedTicks) - tick);
        default:
            throw new Error("route checkpoint is not a wait");
    }
}

export function validateRouteExecution(
    definition: RouteDefinition,
    alwaysCheckCurrentPoint: boolean,
): void {
    if (definition.checkpoints.length > 0 && !alwaysCheckCurrentPoint) {
        throw new RangeError("route execution requires alwaysCheckCurrentPoint");
    }
    if (definition.checkpoints.length > 0 && !definition.visitEveryCheckPoint) {
        throw new RangeError("route execution does not support skipping checkpoints or reaching the end early");
    }
    for (const checkpoint of definition.checkpoints) {
        switch (checkpoint.type) {
            case "MOVE":
            case "PATROL_MOVE":
            case "MAP_OFFSET_MOVE":
            case "WAIT_FOR_TICKS":
            case "WAIT_FOR_PLAY_TICK":
            case "WAIT_CURRENT_FRAGMENT_TICKS":
            case "WAIT_CURRENT_WAVE_TICKS":
                break;
            default:
                throw new RangeError(`unsupported route execution checkpoint: ${checkpoint.type}`);
        }
    }
}

export function enterRoute(state: RouteState, context: RouteExecutionContext): RouteTransition {
    const progress = state.progress;
    if (progress.phase !== "CHECKPOINTS" || progress.checkpoint.type !== "NOT_ENTERED") {
        return { state };
    }
    if (progress.checkpointIndex >= state.definition.checkpoints.length) {
        const request = navigationRequest(state, null, Tile.center(state.definition.endPosition), context);
        return {
            state: withProgress(state, { phase: "END", move: moveProgress(request) }),
            request,
        };
    }
    const checkpoint = state.definition.checkpoints[progress.checkpointIndex]!;
    switch (checkpoint.type) {
        case "MOVE":
        case "PATROL_MOVE":
        case "MAP_OFFSET_MOVE": {
            const position = resolveMovePosition(checkpoint.target, context.rng, checkpoint.type === "MAP_OFFSET_MOVE");
            const request = navigationRequest(state, checkpoint.target, position, context);
            return {
                state: withProgress(state, {
                    phase: "CHECKPOINTS",
                    checkpointIndex: progress.checkpointIndex,
                    checkpoint: moveProgress(request),
                }),
                request,
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
            };
        default:
            throw new RangeError(`unsupported route execution checkpoint: ${checkpoint.type}`);
    }
}

export function nextCheckpointIndex(definition: RouteDefinition, checkpointIndex: number): number {
    const checkpoints = definition.checkpoints;
    const nextIndex = checkpointIndex + 1;
    if (checkpoints[checkpointIndex]?.type !== "PATROL_MOVE"
        || (nextIndex < checkpoints.length && checkpoints[nextIndex]!.type !== "MOVE")) {
        return nextIndex;
    }
    let segmentStart = checkpointIndex;
    while (segmentStart > 0 && checkpoints[segmentStart - 1]!.type !== "MOVE") {
        segmentStart--;
    }
    return segmentStart < checkpointIndex ? segmentStart : nextIndex;
}

export function advanceRoute(state: RouteState, context: RouteExecutionContext): RouteTransition {
    const progress = state.progress;
    if (progress.phase === "COMPLETED") {
        return { state };
    }
    if (progress.phase === "END") {
        return { state: withProgress(state, { phase: "COMPLETED" }) };
    }
    if (progress.checkpoint.type === "NOT_ENTERED") {
        throw new Error("cannot advance a route checkpoint before entering it");
    }
    let nextIndex = nextCheckpointIndex(state.definition, progress.checkpointIndex);
    if (nextIndex < progress.checkpointIndex && !context.tryRestartPatrol(progress.checkpointIndex)) {
        nextIndex = progress.checkpointIndex + 1;
    }
    return enterRoute(withProgress(state, {
        phase: "CHECKPOINTS",
        checkpointIndex: nextIndex,
        checkpoint: { type: "NOT_ENTERED" },
    }), context);
}

export function tickRouteWait(state: RouteState, tick: number): RouteState {
    const progress = state.progress;
    if (progress.phase !== "CHECKPOINTS" || progress.checkpoint.type !== "WAIT") {
        return state;
    }
    const checkpoint = state.definition.checkpoints[progress.checkpointIndex]!;
    const remainingTicks = checkpoint.type === "WAIT_FOR_TICKS"
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
