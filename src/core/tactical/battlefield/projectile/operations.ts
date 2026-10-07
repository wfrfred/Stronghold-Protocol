import { ownProjectileInstance } from "./internal/state.js";
import { assertNonnegativeNumber, assertNonnegativeSafeInteger } from "../../../common/assert.js";
import type { WorldPosition } from "../../geometry/coordinate.js";
import type { RangeGeometry } from "../../geometry/shape.js";
import type { UnitId } from "../../unit/unit.js";
import type { ProjectileProgramRef } from "./program.js";
import type { ProjectileResources } from "./resources.js";
import {
    copyProjectileState,
    type ProjectileId,
    type ProjectileInstance,
    type ProjectileState,
} from "./state.js";

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

export function withProjectileOperations<T>(
    state: ProjectileState,
    resources: ProjectileResources,
    tick: number,
    run: (operations: ProjectileOperations) => T,
): { readonly state: ProjectileState; readonly result: T } {
    let current = copyProjectileState(state);
    let active = true;

    const readState = (): ProjectileState => {
        if (!active) {
            throw new TypeError("projectile operations are no longer active");
        }

        return current;
    };

    const operations: ProjectileOperations = {
        get: (id) => readState().instances.find((instance) => instance.id === id),
        launch: (ref, input) => {
            const previous = readState();
            const nextProjectileId = previous.nextProjectileId + 1;

            if (!Number.isSafeInteger(nextProjectileId)) {
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
            const instance = ownProjectileInstance({
                id: previous.nextProjectileId,
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
                state: resources.ownState(ref, input.initialState ?? program.initialize()),
            });
            current = copyProjectileState({
                nextProjectileId,
                instances: [...previous.instances, instance],
            });

            return instance.id;
        },
    };

    try {
        const result = run(operations);

        if (result instanceof Promise) {
            throw new TypeError("projectile operations must complete synchronously");
        }

        return { state: current, result };
    } finally {
        active = false;
    }
}
