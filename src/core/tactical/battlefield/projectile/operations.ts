import { ProjectileWork } from "./internal/state.js";
import { assertNonnegativeNumber, assertNonnegativeSafeInteger } from "../../../common/assert.js";
import type { SynchronousResult } from "../../../common/synchronous.js";
import type { WorldPosition } from "../../geometry/coordinate.js";
import type { RangeGeometry } from "../../geometry/shape.js";
import type { UnitId } from "../../unit/unit.js";
import type { ProjectileProgramRef } from "./program.js";
import type { ProjectileResources } from "./resources.js";
import type { BattlefieldChange } from "../contract.js";
import type { ProjectileId, ProjectileInstance, ProjectileView } from "./state.js";

export interface ProjectileLaunchInput<S extends object = object> {
    readonly source: UnitId | null;
    readonly traceTarget: UnitId | null;
    readonly position: WorldPosition;
    readonly destination: WorldPosition;
    readonly cachedAtk: number;
    readonly speedPerTick: number;
    readonly contactRange: RangeGeometry;
    readonly stopDelayTicks: number;
    readonly expiresAtTick?: number | null;
    readonly initialState?: S;
}

export interface ProjectileOperations {
    launch<S extends object>(
        ref: ProjectileProgramRef<S>,
        input: ProjectileLaunchInput<NoInfer<S>>,
    ): ProjectileId;
    get(id: ProjectileId): ProjectileInstance | undefined;
}

export function withProjectileOperations(
    battlefield: ProjectileView,
    nextProjectileId: ProjectileId,
    resources: ProjectileResources,
    tick: number,
    run: (operations: ProjectileOperations) => undefined,
): {
    readonly changes: readonly BattlefieldChange[];
    readonly nextProjectileId: ProjectileId;
    readonly result: undefined;
};
export function withProjectileOperations<T>(
    battlefield: ProjectileView,
    nextProjectileId: ProjectileId,
    resources: ProjectileResources,
    tick: number,
    run: (operations: ProjectileOperations) => SynchronousResult<T>,
): {
    readonly changes: readonly BattlefieldChange[];
    readonly nextProjectileId: ProjectileId;
    readonly result: T;
};
export function withProjectileOperations<T>(
    battlefield: ProjectileView,
    nextProjectileId: ProjectileId,
    resources: ProjectileResources,
    tick: number,
    run: (operations: ProjectileOperations) => SynchronousResult<T>,
): {
    readonly changes: readonly BattlefieldChange[];
    readonly nextProjectileId: ProjectileId;
    readonly result: T;
} {
    assertNonnegativeSafeInteger(nextProjectileId, "projectile identity");
    const current = new ProjectileWork(battlefield);
    let active = true;

    const readWork = (): ProjectileWork => {
        if (!active) {
            throw new TypeError("projectile operations are no longer active");
        }

        return current;
    };

    const operations: ProjectileOperations = {
        get: (id) => readWork().get(id),
        launch: (ref, input) => {
            const previous = readWork();
            const allocatedNextId = nextProjectileId + 1;

            if (!Number.isSafeInteger(allocatedNextId)) {
                throw new RangeError("projectile identity overflow");
            }

            assertNonnegativeSafeInteger(tick, "projectile launch tick");
            assertNonnegativeNumber(input.cachedAtk, "projectile cached attack");
            assertNonnegativeNumber(input.speedPerTick, "projectile speed per tick");
            assertNonnegativeSafeInteger(input.stopDelayTicks, "projectile stop delay");

            if (input.source !== null) {
                assertNonnegativeSafeInteger(input.source, "projectile source identity");
            }
            if (input.traceTarget !== null) {
                assertNonnegativeSafeInteger(input.traceTarget, "projectile target identity");
            }
            if (input.expiresAtTick !== undefined && input.expiresAtTick !== null) {
                assertNonnegativeSafeInteger(input.expiresAtTick, "projectile expiration tick");
            }

            const program = resources.get(ref);
            const instance: ProjectileInstance = {
                id: nextProjectileId,
                programRef: ref,
                source: input.source,
                traceTarget: input.traceTarget,
                position: input.position,
                destination: input.destination,
                cachedAtk: input.cachedAtk,
                speedPerTick: input.speedPerTick,
                contactRange: input.contactRange,
                stopDelayTicks: input.stopDelayTicks,
                launchedAtTick: tick,
                lastAdvancedTick: tick,
                expiresAtTick: input.expiresAtTick ?? null,
                progress: { type: "FLYING" },
                hitUnitIds: [],
                state: input.initialState ?? program.initialize(),
            };
            previous.add(instance);
            nextProjectileId = allocatedNextId;

            return instance.id;
        },
    };

    try {
        const result = run(operations);

        return {
            changes: current.changes(),
            nextProjectileId,
            result,
        };
    } finally {
        active = false;
    }
}
