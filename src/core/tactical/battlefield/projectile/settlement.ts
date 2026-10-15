import { all, getProjectile, ref, replaceProjectile } from "./operations.js";
import type { Ref } from "../../../common/ref.js";
import { World, type WorldPosition } from "../../geometry/coordinate.js";
import { rangeOverlapsHit } from "../../geometry/intersection.js";
import {
    appendEvents,
    battlefieldView,
    getUnit,
    type State as BattleState,
} from "../../battle/state.js";
import { emptyCall, type CallContext } from "../../battle/execution/call.js";
import type { Unit, Id } from "../../unit/unit.js";
import { hasHit } from "../../unit/capability/spatial/capability.js";
import { isSpatiallyPresent } from "../../unit/capability/presence/capability.js";
import type { ProjectileQueryContext } from "./context.js";
import type { Definition } from "./definition.js";
import type { ProjectileId, Projectile, ProjectileStopReason } from "./projectile.js";
import type { Projectiles } from "./projectiles.js";

type StoredProjectile = ReturnType<Projectiles["values"]>[number];

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
    call: CallContext,
): ProjectileQueryContext<S> {
    return { projectile, tick, facts: battlefieldView(state), call };
}

function signalFacts(projectile: StoredProjectile, tick: number): Omit<ProjectileSignal, "type"> {
    return {
        projectileId: projectile.id,
        source: projectile.source,
        tick,
        position: projectile.position,
    };
}

function inContactArea(projectile: StoredProjectile, target: Unit): boolean {
    return (
        isSpatiallyPresent(target) &&
        hasHit(target) &&
        rangeOverlapsHit(
            projectile.contactRange,
            projectile.position,
            target.position,
            target.hit.geometry,
        )
    );
}

function contact<S extends object>(
    state: BattleState,
    projectile: Projectile<S>,
    definition: Definition<S>,
    tick: number,
    call: CallContext,
): BattleState {
    if (definition.contact === undefined) {
        return state;
    }

    const candidates = [...battlefieldView(state).unitIds].sort((left, right) => left - right);
    const reference = ref(projectile);

    for (const targetUnitId of candidates) {
        const current = getProjectile(state, reference);
        const target = getUnit(state, targetUnitId);

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
        if (!definition.acceptsContact(projectileContext(state, current, tick, call), target)) {
            continue;
        }

        const contacted: Projectile<S> = {
            ...current,
            hitUnitIds: [...current.hitUnitIds, targetUnitId],
        };
        state = replaceProjectile(state, contacted);
        state = definition.contact(state, {
            ...projectileContext(state, contacted, tick, call),
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
    reference: Ref<StoredProjectile>,
    tick: number,
    reason: ProjectileStopReason = "EXPLICIT",
    call: CallContext = emptyCall,
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
                    : stopped.definition.stop(state, projectileContext(state, stopped, tick, call));

            if (getProjectile(state, reference) === undefined) {
                return state;
            }

            const projectiles = state.battlefield.projectiles.remove(reference.id);

            return { ...state, battlefield: { ...state.battlefield, projectiles } };
        }) ?? state
    );
}

function advanceProjectile(
    state: BattleState,
    reference: Ref<StoredProjectile>,
    tick: number,
    call: CallContext,
): BattleState {
    return (
        state.battlefield.projectiles.read(reference.id, (current) => {
            if (current.lastAdvancedTick >= tick) {
                return state;
            }
            if (current.expiresAtTick !== null && tick >= current.expiresAtTick) {
                return stopProjectile(state, reference, tick, "EXPIRED", call);
            }
            switch (current.progress.type) {
                case "STOPPED":
                    return state;

                case "WAITING_TO_STOP":
                    return tick >= current.progress.targetTick
                        ? stopProjectile(state, reference, tick, "ARRIVED", call)
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
                    const reached = World.withinDistance(
                        current.position,
                        destination,
                        current.speedPerTick,
                    );
                    const position = reached
                        ? destination
                        : World.translate(
                              current.position,
                              World.clampMagnitude(
                                  World.difference(destination, current.position),
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
                        state = contact(state, advanced, advanced.definition, tick, call);

                        if (current.stopDelayTicks === 0) {
                            state = stopProjectile(state, reference, tick, "ARRIVED", call);
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
    call: CallContext = emptyCall,
): BattleState {
    for (const id of stopIds) {
        const projectile = state.battlefield.projectiles.get(id);

        if (projectile !== undefined) {
            state = stopProjectile(state, ref(projectile), tick, "EXPLICIT", call);
        }
    }

    const candidates = all(state).sort((left, right) => left.id - right.id);

    for (const reference of candidates) {
        state = advanceProjectile(state, reference, tick, call);
    }

    return state;
}
