import type { TilePosition, WorldOffset } from "../../core/tactical/geometry/coordinate.js";
import { createRouteDefinition } from "../../core/tactical/route/definition.js";
import type { RouteCheckpoint, RouteDefinition, RouteMoveTarget } from "../../core/tactical/route/definition.js";
import { secondsToTicks } from "./tick.js";

function object(value: unknown, name: string, fields: readonly string[]): Record<string, unknown> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
        throw new TypeError(`${name} must be an object`);
    }

    const data = value as Record<string, unknown>;
    for (const key of Object.keys(data)) {
        if (!fields.includes(key)) {
            throw new TypeError(`${name} has unsupported field ${key}`);
        }
    }
    return data;
}

function number(value: unknown, name: string): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new RangeError(`${name} must be finite`);
    }

    return value;
}

function boolean(value: unknown, name: string): boolean {
    if (typeof value !== "boolean") {
        throw new TypeError(`${name} must be boolean`);
    }

    return value;
}

function position(value: unknown, name: string): TilePosition {
    const data = object(value, name, ["row", "col"]);
    return [number(data.row, `${name}.row`), number(data.col, `${name}.col`)];
}

function offset(value: unknown, name: string): WorldOffset {
    const data = object(value, name, ["x", "y"]);
    return [number(data.x, `${name}.x`), number(data.y, `${name}.y`)];
}

function moveTarget(data: Record<string, unknown>): RouteMoveTarget {
    return {
        position: position(data.position, "checkpoint.position"),
        reachOffset: offset(data.reachOffset, "checkpoint.reachOffset"),
        randomizeReachOffset: boolean(data.randomizeReachOffset, "checkpoint.randomizeReachOffset"),
        reachDistance: number(data.reachDistance, "checkpoint.reachDistance"),
    };
}

function checkpoint(value: unknown): RouteCheckpoint {
    const data = object(value, "checkpoint", [
        "type", "time", "position", "reachOffset", "randomizeReachOffset", "reachDistance",
    ]);
    switch (data.type) {
        case "MOVE":
        case "PATROL_MOVE":
        case "MAP_OFFSET_MOVE":
            return { type: data.type, target: moveTarget(data) };
        case "WAIT_FOR_SECONDS":
            return {
                type: "WAIT_FOR_TICKS",
                durationTicks: Math.max(0, secondsToTicks(number(data.time, "checkpoint.time"), "checkpoint.time")),
            };
        case "WAIT_FOR_PLAY_TIME":
            return {
                type: "WAIT_FOR_PLAY_TICK",
                targetPlayTick: Math.max(0, secondsToTicks(number(data.time, "checkpoint.time"), "checkpoint.time")),
            };
        case "WAIT_CURRENT_FRAGMENT_TIME":
            return {
                type: "WAIT_CURRENT_FRAGMENT_TICKS",
                targetElapsedTicks: Math.max(0, secondsToTicks(number(data.time, "checkpoint.time"), "checkpoint.time")),
            };
        case "WAIT_CURRENT_WAVE_TIME":
            return {
                type: "WAIT_CURRENT_WAVE_TICKS",
                targetElapsedTicks: Math.max(0, secondsToTicks(number(data.time, "checkpoint.time"), "checkpoint.time")),
            };
        case "APPEAR_AT_POS":
            return {
                type: data.type,
                position: position(data.position, "checkpoint.position"),
                reachOffset: offset(data.reachOffset, "checkpoint.reachOffset"),
            };
        case "DISAPPEAR":
        case "ALERT":
            return { type: data.type };
        default:
            throw new RangeError("unsupported Arknights route checkpoint type");
    }
}

export function parseRouteDefinition(value: unknown): RouteDefinition {
    const data = object(value, "route", [
        "motionMode", "startPosition", "endPosition", "spawnOffset", "spawnRandomRange", "checkpoints",
        "allowDiagonalMove", "visitEveryTileCenter", "visitEveryNodeCenter", "visitEveryCheckPoint",
    ]);
    const pathMotionMode = data.motionMode;
    if (pathMotionMode !== "WALK" && pathMotionMode !== "FLY") {
        throw new RangeError("unsupported Arknights route motion mode");
    }
    if (!Array.isArray(data.checkpoints)) {
        throw new TypeError("route.checkpoints must be an array");
    }

    const checkpoints: RouteCheckpoint[] = [];
    for (let index = 0; index < data.checkpoints.length; index++) {
        const value = data.checkpoints[index];
        if (!Object.hasOwn(data.checkpoints, index) || value === undefined) {
            throw new TypeError("route.checkpoints must be dense");
        }

        checkpoints.push(checkpoint(value));
    }

    return createRouteDefinition({
        pathMotionMode,
        startPosition: position(data.startPosition, "route.startPosition"),
        endPosition: position(data.endPosition, "route.endPosition"),
        spawnOffset: offset(data.spawnOffset, "route.spawnOffset"),
        spawnRandomRange: offset(data.spawnRandomRange, "route.spawnRandomRange"),
        checkpoints,
        allowDiagonalMove: boolean(data.allowDiagonalMove, "route.allowDiagonalMove"),
        visitEveryTileCenter: boolean(data.visitEveryTileCenter, "route.visitEveryTileCenter"),
        visitEveryNodeCenter: boolean(data.visitEveryNodeCenter, "route.visitEveryNodeCenter"),
        visitEveryCheckPoint: boolean(data.visitEveryCheckPoint, "route.visitEveryCheckPoint"),
    });
}
