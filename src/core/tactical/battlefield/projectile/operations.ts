import { assertNonnegativeNumber, assertNonnegativeSafeInteger } from "../../../common/assert.js";
import {
    advanceBattlefield,
    battlefieldView,
    type BattleState,
    type Result,
} from "../../battle/state.js";
import { resolveAttackPower } from "../../unit/capability/offense/query.js";
import type { WorldPosition } from "../../geometry/coordinate.js";
import type { RangeGeometry } from "../../geometry/shape.js";
import type { Id } from "../../unit/unit.js";
import type { ProjectileDefinitionRef } from "./definition.js";
import type { ProjectileResources } from "./resources.js";
import type { ProjectileId, Projectile } from "./projectile.js";

export interface ProjectileLaunchInput<S extends object = object> {
    readonly source: Id | null;
    readonly traceTarget: Id | null;
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
        state: BattleState,
        ref: ProjectileDefinitionRef<S>,
        input: ProjectileLaunchInput<NoInfer<S>>,
    ): Result<ProjectileId>;
    get(state: BattleState, id: ProjectileId): Projectile | undefined;
}

export function getProjectile(state: BattleState, id: ProjectileId): Projectile | undefined {
    return battlefieldView(state).getProjectile(id);
}

export function replaceProjectile(state: BattleState, projectile: Projectile): BattleState {
    const current = getProjectile(state, projectile.id);

    return current === undefined || current === projectile
        ? state
        : advanceBattlefield(state, [{ type: "UPDATE_PROJECTILE", projectile }]);
}

export function resolveProjectileAttackPower(state: BattleState, projectile: Projectile): number {
    return (
        (projectile.source === null
            ? undefined
            : resolveAttackPower(projectile.source, battlefieldView(state))) ?? projectile.cachedAtk
    );
}

export function launchProjectile<S extends object>(
    state: BattleState,
    ref: ProjectileDefinitionRef<S>,
    input: ProjectileLaunchInput<NoInfer<S>>,
    resources: ProjectileResources,
    tick: number,
): Result<ProjectileId> {
    const id = state.execution.nextProjectileId;
    const nextProjectileId = id + 1;
    assertNonnegativeSafeInteger(id, "projectile identity");

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

    const definition = resources.get(ref);
    const projectile: Projectile = {
        id,
        definitionRef: ref,
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
        state: input.initialState ?? definition.initialize(),
    };
    state = advanceBattlefield(state, [{ type: "REGISTER_PROJECTILE", projectile }]);

    return { state: { ...state, execution: { ...state.execution, nextProjectileId } }, value: id };
}

export function createProjectileOperations(
    resources: ProjectileResources,
    tick: number,
): ProjectileOperations {
    return {
        get: getProjectile,
        launch: (state, ref, input) => launchProjectile(state, ref, input, resources, tick),
    };
}
