import type { Rng } from "../../common/rng.js";
import { createWorldOffset, Tile, World } from "../geometry/coordinate.js";
import type { WorldPosition } from "../geometry/coordinate.js";
import { createNavigationRequest } from "../navigation/request.js";
import type { NavigationRequest, NavigationRequestId } from "../navigation/request.js";
import type { RouteDefinition, RouteMoveTarget } from "./definition.js";
import type { RouteClock, RouteMoveProgress, RouteProgress, RouteState } from "./progress.js";

export interface RouteExecutionContext {
    readonly rng: Rng;
    readonly nextNavigationRequestId: () => NavigationRequestId;
}

export interface RouteTransition {
    readonly state: RouteState;
    readonly request?: NavigationRequest;
}

function withProgress(state: RouteState, progress: RouteProgress): RouteState {
    return {
        definition: state.definition,
        clockBinding: state.clockBinding,
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

function resolveMovePosition(target: RouteMoveTarget, rng: Rng): WorldPosition {
    const center = Tile.center(target.position);
    if (!target.randomizeReachOffset) {
        return World.translate(center, target.reachOffset);
    }
    for (let axis = 0; axis < 2; axis++) {
        const range = target.reachOffset[axis]!;
        const coordinate = center[axis]!;
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
    return World.translate(center, offset);
}

export function validateRouteExecution(
    definition: RouteDefinition,
    alwaysCheckCurrentPoint: boolean,
): void {
    if (!alwaysCheckCurrentPoint) {
        throw new RangeError("route execution requires alwaysCheckCurrentPoint");
    }
    if (!definition.visitEveryCheckPoint) {
        throw new RangeError("route execution does not support skipping checkpoints or reaching the end early");
    }
    for (const checkpoint of definition.checkpoints) {
        if (checkpoint.type !== "MOVE" && checkpoint.type !== "WAIT_FOR_SECONDS") {
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
        case "MOVE": {
            const position = resolveMovePosition(checkpoint.target, context.rng);
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
        case "WAIT_FOR_SECONDS":
            return {
                state: withProgress(state, {
                    phase: "CHECKPOINTS",
                    checkpointIndex: progress.checkpointIndex,
                    checkpoint: {
                        type: "WAIT",
                        remainingSeconds: checkpoint.durationSeconds,
                    },
                }),
            };
        default:
            throw new RangeError(`unsupported route execution checkpoint: ${checkpoint.type}`);
    }
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
    return enterRoute(withProgress(state, {
        phase: "CHECKPOINTS",
        checkpointIndex: progress.checkpointIndex + 1,
        checkpoint: { type: "NOT_ENTERED" },
    }), context);
}

export function tickRouteWait(state: RouteState, clock: RouteClock): RouteState {
    const progress = state.progress;
    if (progress.phase !== "CHECKPOINTS" || progress.checkpoint.type !== "WAIT") {
        return state;
    }
    const remainingSeconds = Math.max(0, progress.checkpoint.remainingSeconds - clock.deltaTimeSeconds);
    if (remainingSeconds === progress.checkpoint.remainingSeconds) {
        return state;
    }
    return withProgress(state, {
        phase: "CHECKPOINTS",
        checkpointIndex: progress.checkpointIndex,
        checkpoint: { type: "WAIT", remainingSeconds },
    });
}
