import { assertNonnegativeNumber, assertNonnegativeSafeInteger } from "../../../common/assert.js";
import type { Ref } from "../../../common/ref.js";
import { battlefieldView, type State as BattleState, type Result } from "../../battle/state.js";
import { resolveAttackPower } from "../../unit/capability/offense/query.js";
import type { WorldPosition } from "../../geometry/coordinate.js";
import type { Range } from "../../geometry/range.js";
import type { Id } from "../../unit/unit.js";
import type { Definition } from "./definition.js";
import type { Projectile } from "./projectile.js";
import type { Projectiles } from "./projectiles.js";

type StoredProjectile = ReturnType<Projectiles["values"]>[number];

export interface ProjectileLaunchInput<S extends object = object> {
    readonly source: Id | null;
    readonly traceTarget: Id | null;
    readonly position: WorldPosition;
    readonly destination: WorldPosition;
    readonly cachedAtk: number;
    readonly speedPerTick: number;
    readonly contactRange: Range;
    readonly stopDelayTicks: number;
    readonly expiresAtTick?: number | null;
    readonly initialState?: S;
}

export function ref<P extends StoredProjectile>(projectile: P): Ref<P> {
    return { id: projectile.id } as Ref<P>;
}

export function all(state: BattleState): Ref<StoredProjectile>[] {
    return state.battlefield.projectiles.values().map(ref);
}

export function getProjectile<P extends StoredProjectile>(
    state: BattleState,
    reference: Ref<P>,
): P | undefined {
    return state.battlefield.projectiles.get(reference.id) as P | undefined;
}

export function replaceProjectile<S extends object>(
    state: BattleState,
    projectile: Projectile<S>,
): BattleState {
    const current = getProjectile(state, ref(projectile));

    if (current === undefined || current === projectile) {
        return state;
    }

    const projectiles = state.battlefield.projectiles.replace(projectile);

    return { ...state, battlefield: { ...state.battlefield, projectiles } };
}

export function resolveProjectileAttackPower(
    state: BattleState,
    projectile: StoredProjectile,
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
): Result<Ref<Projectile<S>>> {
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

    return {
        state: { ...state, execution: { ...state.execution, nextProjectileId } },
        value: ref(projectile),
    };
}
