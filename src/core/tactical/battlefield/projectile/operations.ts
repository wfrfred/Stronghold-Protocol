import { ownProjectileInstance, ProjectileWork } from "./internal/state.js";
import { assertNonnegativeNumber, assertNonnegativeSafeInteger } from "../../../common/assert.js";
import type { SynchronousResult } from "../../../common/synchronous.js";
import type { WorldPosition } from "../../geometry/coordinate.js";
import type { RangeGeometry } from "../../geometry/shape.js";
import type { UnitId } from "../../unit/unit.js";
import type { ProjectileProgramRef } from "./program.js";
import type { ProjectileResources } from "./resources.js";
import type { ProjectileId, ProjectileInstance, ProjectileState } from "./state.js";

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
    state: ProjectileState,
    resources: Pick<ProjectileResources, "get" | "ownState">,
    tick: number,
    run: (operations: ProjectileOperations) => undefined,
): { readonly state: ProjectileState; readonly result: undefined };
export function withProjectileOperations<T>(
    state: ProjectileState,
    resources: Pick<ProjectileResources, "get" | "ownState">,
    tick: number,
    run: (operations: ProjectileOperations) => SynchronousResult<T>,
): { readonly state: ProjectileState; readonly result: T };
export function withProjectileOperations<T>(
    state: ProjectileState,
    resources: Pick<ProjectileResources, "get" | "ownState">,
    tick: number,
    run: (operations: ProjectileOperations) => SynchronousResult<T>,
): { readonly state: ProjectileState; readonly result: T } {
    const current = new ProjectileWork(state);
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
            current.add(instance);

            return instance.id;
        },
    };

    try {
        const result = run(operations);

        return { state: current.result(), result };
    } finally {
        active = false;
    }
}
