import { assertNonnegativeSafeInteger } from "../../../common/assert.js";
import type { Ref } from "../../../common/ref.js";
import { appendEvents, type State as BattleState, type Result } from "../../battle/state.js";
import type { WorldPosition } from "../../geometry/coordinate.js";
import type { Definition, StopReason } from "./definition.js";
import type { Projectile, View } from "./projectile.js";

export interface CreateInput<S extends object> {
    readonly position: WorldPosition;
    readonly state: S;
}

export function ref<P extends View>(self: P): Ref<P> {
    return { id: self.id } as Ref<P>;
}

export function get<P extends View>(battle: BattleState, reference: Ref<P>): P | undefined {
    return battle.battlefield.projectiles.get(reference);
}

export function create<S extends object>(
    battle: BattleState,
    definition: Definition<S>,
    input: CreateInput<NoInfer<S>>,
): Result<Ref<Projectile<S>>> {
    const id = battle.execution.nextProjectileId;
    const nextProjectileId = id + 1;
    assertNonnegativeSafeInteger(id, "projectile identity");

    if (!Number.isSafeInteger(nextProjectileId)) {
        throw new RangeError("projectile identity overflow");
    }
    if (definition.id.length === 0) {
        throw new TypeError("projectile definition identity must be nonempty");
    }

    const self: Projectile<S> = {
        id,
        definition,
        lifecycle: "ACTIVE",
        position: input.position,
        state: input.state,
    };
    const reference = ref(self);
    battle = {
        ...battle,
        execution: { ...battle.execution, nextProjectileId },
        battlefield: {
            ...battle.battlefield,
            projectiles: battle.battlefield.projectiles.add(self),
        },
    };

    return {
        state: definition.onCreate?.(battle, self) ?? battle,
        value: reference,
    };
}

export function update<S extends object>(
    battle: BattleState,
    reference: Ref<Projectile<S>>,
    transform: (current: Projectile<NoInfer<S>>) => {
        readonly position?: WorldPosition;
        readonly state?: NoInfer<S>;
    },
): BattleState {
    const current = get(battle, reference);

    if (current === undefined) {
        return battle;
    }

    const changes = transform(current);
    const position = changes.position ?? current.position;
    const state = changes.state ?? current.state;

    if (position === current.position && state === current.state) {
        return battle;
    }

    const projectiles = battle.battlefield.projectiles.replace(reference, {
        ...current,
        position,
        state,
    });

    return { ...battle, battlefield: { ...battle.battlefield, projectiles } };
}

export function stop(
    battle: BattleState,
    reference: Ref<View>,
    reason: StopReason = "EXPLICIT",
): BattleState {
    return (
        battle.battlefield.projectiles.read(reference.id, (current) => {
            if (current.lifecycle !== "ACTIVE") {
                return battle;
            }

            const self: Projectile<typeof current.state> = {
                ...current,
                lifecycle: "ENDING",
            };
            const projectiles = battle.battlefield.projectiles.replace(ref(current), self);
            battle = { ...battle, battlefield: { ...battle.battlefield, projectiles } };
            battle = appendEvents(battle, [
                {
                    type: "PROJECTILE_STOPPED",
                    projectileId: self.id,
                    position: self.position,
                    tick: battle.tick,
                    reason,
                },
            ]);
            battle = self.definition.onTerminate?.(battle, self, reason) ?? battle;

            return {
                ...battle,
                battlefield: {
                    ...battle.battlefield,
                    projectiles: battle.battlefield.projectiles.remove(reference.id),
                },
            };
        }) ?? battle
    );
}
