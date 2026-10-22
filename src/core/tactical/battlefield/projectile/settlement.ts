import { all, getProjectile, ref, replaceProjectile } from "./operations.js";
import type { Ref } from "../../../common/ref.js";
import { sort } from "../../../common/collection.js";
import { World, type WorldPosition } from "../../geometry/coordinate.js";
import { overlaps } from "../../geometry/intersection.js";
import {
    appendEvents,
    battlefieldView,
    getUnit,
    type State as BattleState,
} from "../../battle/state.js";
import type { Unit, Id } from "../../unit/unit.js";
import { hasHitbox } from "../../unit/capability/hitbox/capability.js";
import { isSpatiallyPresent } from "../../unit/capability/presence/capability.js";
import * as units from "../../unit/query.js";
import type { ProjectileQueryContext } from "./context.js";
import type { Definition } from "./definition.js";
import type { ProjectileId, Projectile, ProjectileStopReason, View } from "./projectile.js";

export type ProjectileSignal = {
    readonly projectileId: ProjectileId;
    readonly source: Id | null;
    readonly tick: number;
    readonly position: WorldPosition;
} & (
    | { readonly type: "PROJECTILE_REACHED" }
    | { readonly type: "PROJECTILE_HIT"; readonly targetUnitId: Id }
    | { readonly type: "PROJECTILE_STOPPED"; readonly reason: ProjectileStopReason }
);

function projectileContext<S extends object>(
    state: BattleState,
    projectile: Projectile<S>,
    tick: number,
): ProjectileQueryContext<S> {
    return { projectile, tick, facts: battlefieldView(state) };
}

function signalFacts(projectile: View, tick: number): Omit<ProjectileSignal, "type"> {
    return {
        projectileId: projectile.id,
        source: projectile.source,
        tick,
        position: projectile.position,
    };
}

function inContactArea(projectile: View, target: Unit): boolean {
    return (
        isSpatiallyPresent(target) &&
        hasHitbox(target) &&
        overlaps(
            projectile.contactRange,
            projectile.position,
            target.definition.hitbox.shape,
            target.position,
        )
    );
}

function contact<S extends object>(
    state: BattleState,
    projectile: Projectile<S>,
    definition: Definition<S>,
    tick: number,
): BattleState {
    if (definition.contact === undefined) {
        return state;
    }

    const candidates = sort(units.all(state).map(units.ref), (left, right) => left.id - right.id);
    const reference = ref(projectile);

    for (const targetRef of candidates) {
        const targetUnitId = targetRef.id;
        const current = getProjectile(state, reference);
        const target = units.get(state, targetRef);

        if (current === undefined || current.progress.type === "STOPPED") {
            return state;
        }
        if (
            target === undefined ||
            !inContactArea(current, target) ||
            current.hitUnitIds.includes(targetUnitId)
        ) {
            continue;
        }
        if (!definition.acceptsContact(projectileContext(state, current, tick), target)) {
            continue;
        }

        const contacted: Projectile<S> = {
            ...current,
            hitUnitIds: [...current.hitUnitIds, targetUnitId],
        };
        state = replaceProjectile(state, contacted);
        state = definition.contact(state, {
            ...projectileContext(state, contacted, tick),
            targetUnitId,
        });
        const latest = getProjectile(state, reference) ?? contacted;
        state = appendEvents(state, [
            { ...signalFacts(latest, tick), type: "PROJECTILE_HIT", targetUnitId },
        ]);
    }

    return state;
}

export function stopProjectile(
    state: BattleState,
    reference: Ref<View>,
    tick: number,
    reason: ProjectileStopReason = "EXPLICIT",
): BattleState {
    const current = getProjectile(state, reference);

    if (current === undefined || current.progress.type === "STOPPED") {
        return state;
    }

    return (
        state.battlefield.projectiles.read(reference.id, (projectile) => {
            const stopped: Projectile<typeof projectile.state> = {
                ...projectile,
                progress: { type: "STOPPED", reason },
            };
            state = replaceProjectile(state, stopped);
            state = appendEvents(state, [
                { ...signalFacts(stopped, tick), type: "PROJECTILE_STOPPED", reason },
            ]);
            state =
                stopped.definition.stop === undefined
                    ? state
                    : stopped.definition.stop(state, projectileContext(state, stopped, tick));

            if (getProjectile(state, reference) === undefined) {
                return state;
            }

            const projectiles = state.battlefield.projectiles.remove(reference.id);

            return { ...state, battlefield: { ...state.battlefield, projectiles } };
        }) ?? state
    );
}

function advanceProjectile(state: BattleState, reference: Ref<View>, tick: number): BattleState {
    return (
        state.battlefield.projectiles.read(reference.id, (current) => {
            if (current.lastAdvancedTick >= tick) {
                return state;
            }
            if (current.expiresAtTick !== null && tick >= current.expiresAtTick) {
                return stopProjectile(state, reference, tick, "EXPIRED");
            }
            switch (current.progress.type) {
                case "STOPPED":
                    return state;

                case "WAITING_TO_STOP":
                    return tick >= current.progress.targetTick
                        ? stopProjectile(state, reference, tick, "ARRIVED")
                        : replaceProjectile(state, { ...current, lastAdvancedTick: tick });

                case "FLYING": {
                    const target =
                        current.traceTarget === null
                            ? undefined
                            : getUnit(state, current.traceTarget);
                    const destination =
                        target !== undefined && isSpatiallyPresent(target)
                            ? target.position
                            : current.destination;
                    const reached =
                        World.distanceSquared(current.position, destination) <=
                        current.speedPerTick * current.speedPerTick;
                    const position = reached
                        ? destination
                        : World.add(
                              current.position,
                              World.clampLength(
                                  World.sub(destination, current.position),
                                  current.speedPerTick,
                              ),
                          );
                    const targetTick = tick + current.stopDelayTicks;

                    if (reached && !Number.isSafeInteger(targetTick)) {
                        throw new RangeError("projectile stop deadline overflow");
                    }

                    const advanced: Projectile<typeof current.state> = {
                        ...current,
                        position,
                        destination,
                        lastAdvancedTick: tick,
                        ...(reached
                            ? { progress: { type: "WAITING_TO_STOP", targetTick } as const }
                            : {}),
                    };
                    state = replaceProjectile(state, advanced);

                    if (reached) {
                        state = appendEvents(state, [
                            { ...signalFacts(advanced, tick), type: "PROJECTILE_REACHED" },
                        ]);
                        state = contact(state, advanced, advanced.definition, tick);

                        if (current.stopDelayTicks === 0) {
                            state = stopProjectile(state, reference, tick, "ARRIVED");
                        }
                    }

                    return state;
                }
            }
        }) ?? state
    );
}

export function advanceProjectiles(
    state: BattleState,
    tick: number,
    stopIds: readonly ProjectileId[] = [],
): BattleState {
    for (const id of stopIds) {
        const projectile = state.battlefield.projectiles.get(id);

        if (projectile !== undefined) {
            state = stopProjectile(state, ref(projectile), tick, "EXPLICIT");
        }
    }

    const candidates = all(state).sort((left, right) => left.id - right.id);

    for (const reference of candidates) {
        state = advanceProjectile(state, reference, tick);
    }

    return state;
}
