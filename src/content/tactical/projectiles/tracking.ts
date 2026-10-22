import type { Ref } from "../../../core/common/ref.js";
import { appendEvents, type State as BattleState } from "../../../core/tactical/battle/state.js";
import type { Definition as ProjectileDefinition } from "../../../core/tactical/battlefield/projectile/definition.js";
import type {
    Projectile,
    Snapshot,
} from "../../../core/tactical/battlefield/projectile/projectile.js";
import * as projectiles from "../../../core/tactical/battlefield/projectile/operations.js";
import { World, type WorldPosition } from "../../../core/tactical/geometry/coordinate.js";
import { hasOffense } from "../../../core/tactical/unit/capability/offense/capability.js";
import { resolveAttack } from "../../../core/tactical/unit/capability/offense/query.js";
import { isSpatiallyPresent } from "../../../core/tactical/unit/capability/presence/capability.js";
import type { Vitality } from "../../../core/tactical/unit/capability/vitality/capability.js";
import * as units from "../../../core/tactical/unit/query.js";
import type { Unit } from "../../../core/tactical/unit/unit.js";

export interface State {
    readonly source: Ref<Unit> | null;
    readonly target: Ref<Unit & Vitality>;
    readonly destination: WorldPosition;
    readonly cachedAtk: number;
    readonly speedPerTick: number;
    readonly stopDelayTicks: number;
    readonly stopAtTick: number | null;
    readonly hitAttempted: boolean;
    readonly launchedAtTick: number;
}

export interface Definition extends ProjectileDefinition<State> {
    readonly tracking: true;
}

export interface Presentation {
    readonly id: number;
    readonly source: number | null;
    readonly traceTarget: number;
    readonly position: WorldPosition;
    readonly destination: WorldPosition;
    readonly launchedAtTick: number;
}

export function project(self: Snapshot): Presentation | undefined {
    if (!("tracking" in self.definition) || self.definition.tracking !== true) {
        return undefined;
    }

    const state = self.state as State;

    return {
        id: self.id,
        source: state.source?.id ?? null,
        traceTarget: state.target.id,
        position: self.position,
        destination: state.destination,
        launchedAtTick: state.launchedAtTick,
    };
}

export function attackPower<S extends State>(battle: BattleState, self: Projectile<S>): number {
    const source = self.state.source === null ? undefined : units.get(battle, self.state.source);

    if (source === undefined) {
        return self.state.cachedAtk;
    }

    return hasOffense(source)
        ? (resolveAttack(battle, units.ref(source)) ?? self.state.cachedAtk)
        : 0;
}

export function hit<S extends State>(
    battle: BattleState,
    self: Projectile<S>,
    invoke: (battle: BattleState, self: Projectile<S>, target: Unit & Vitality) => BattleState,
): BattleState {
    const reference = projectiles.ref(self);
    const current = projectiles.get(battle, reference);

    if (current === undefined || current.state.hitAttempted) {
        return battle;
    }

    battle = projectiles.update(battle, reference, (latest) => ({
        state: { ...latest.state, hitAttempted: true },
    }));
    const marked = projectiles.get(battle, reference)!;
    const target = units.get(battle, marked.state.target);

    if (target?.lifecycle !== "PRESENT" || target.vitality.hp <= 0) {
        return battle;
    }

    battle = appendEvents(battle, [
        {
            type: "PROJECTILE_HIT",
            projectileId: marked.id,
            source: marked.state.source?.id ?? null,
            targetUnitId: target.id,
            tick: battle.tick,
            position: marked.position,
        },
    ]);

    return invoke(battle, marked, target);
}

export function advance<S extends State>(
    battle: BattleState,
    self: Projectile<S>,
    onReached: (battle: BattleState, self: Projectile<S>) => BattleState,
): BattleState {
    const reference = projectiles.ref(self);
    const current = projectiles.get(battle, reference);

    if (current?.lifecycle !== "ACTIVE") {
        return battle;
    }
    if (current.state.stopAtTick !== null) {
        return battle.tick >= current.state.stopAtTick
            ? projectiles.stop(battle, reference, "ARRIVED")
            : battle;
    }

    const target = units.get(battle, current.state.target);
    const destination =
        target !== undefined && isSpatiallyPresent(target)
            ? target.position
            : current.state.destination;
    const reached =
        World.distanceSquared(current.position, destination) <=
        current.state.speedPerTick * current.state.speedPerTick;
    const position = reached
        ? destination
        : World.add(
              current.position,
              World.clampLength(
                  World.sub(destination, current.position),
                  current.state.speedPerTick,
              ),
          );
    const stopAtTick = reached ? battle.tick + current.state.stopDelayTicks : null;

    if (stopAtTick !== null && !Number.isSafeInteger(stopAtTick)) {
        throw new RangeError("projectile stop deadline overflow");
    }

    battle = projectiles.update(battle, reference, (latest) => ({
        position,
        state: { ...latest.state, destination, stopAtTick },
    }));

    if (!reached) {
        return battle;
    }

    const advanced = projectiles.get(battle, reference)!;
    battle = appendEvents(battle, [
        {
            type: "PROJECTILE_REACHED",
            projectileId: advanced.id,
            source: advanced.state.source?.id ?? null,
            tick: battle.tick,
            position: advanced.position,
        },
    ]);
    battle = onReached(battle, advanced);
    const latest = projectiles.get(battle, reference);

    return latest?.lifecycle === "ACTIVE" &&
        latest.state.stopAtTick !== null &&
        battle.tick >= latest.state.stopAtTick
        ? projectiles.stop(battle, reference, "ARRIVED")
        : battle;
}
