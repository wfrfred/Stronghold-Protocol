import { assertNonnegativeNumber, assertNonnegativeSafeInteger } from "../../../common/assert.js";
import { battlefieldView, type State as BattleState, type Result } from "../../battle/state.js";
import { resolveAttackPower } from "../../unit/capability/offense/query.js";
import type { WorldPosition } from "../../geometry/coordinate.js";
import type { RangeGeometry } from "../../geometry/shape.js";
import type { Id } from "../../unit/unit.js";
import type { Definition } from "./definition.js";
import type { ProjectileId, Projectile, ProjectileView } from "./projectile.js";

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
        definition: Definition<S>,
        input: ProjectileLaunchInput<NoInfer<S>>,
    ): Result<ProjectileId>;
    get(state: BattleState, id: ProjectileId): ReturnType<ProjectileView["getProjectile"]>;
}

export function getProjectile(
    state: BattleState,
    id: ProjectileId,
): ReturnType<ProjectileView["getProjectile"]>;
export function getProjectile<S extends object>(
    state: BattleState,
    id: ProjectileId,
    definition: Definition<S>,
): Projectile<S> | undefined;
export function getProjectile<S extends object>(
    state: BattleState,
    id: ProjectileId,
    definition?: Definition<S>,
): ReturnType<ProjectileView["getProjectile"]> | Projectile<S> | undefined {
    return definition === undefined
        ? state.battlefield.projectiles.get(id)
        : state.battlefield.projectiles.get(id, definition);
}

export function replaceProjectile<S extends object>(
    state: BattleState,
    projectile: Projectile<S>,
): BattleState {
    const current = getProjectile(state, projectile.id);

    if (current === undefined || current === projectile) {
        return state;
    }

    const projectiles = state.battlefield.projectiles.replace(projectile);

    return { ...state, battlefield: { ...state.battlefield, projectiles } };
}

export function resolveProjectileAttackPower(
    state: BattleState,
    projectile: NonNullable<ReturnType<ProjectileView["getProjectile"]>>,
): number {
    return (
        (projectile.source === null
            ? undefined
            : resolveAttackPower(projectile.source, battlefieldView(state))) ?? projectile.cachedAtk
    );
}

export function launchProjectile<S extends object>(
    state: BattleState,
    definition: Definition<S>,
    input: ProjectileLaunchInput<NoInfer<S>>,
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

    const projectile: Projectile<S> = {
        id,
        definition,
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
    const projectiles = state.battlefield.projectiles.add(projectile);
    state = { ...state, battlefield: { ...state.battlefield, projectiles } };

    return { state: { ...state, execution: { ...state.execution, nextProjectileId } }, value: id };
}

export function createProjectileOperations(tick: number): ProjectileOperations {
    return {
        get: getProjectile,
        launch: (state, definition, input) => launchProjectile(state, definition, input, tick),
    };
}
