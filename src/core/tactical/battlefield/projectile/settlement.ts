import { getProjectile, replaceProjectile } from "./operations.js";
import { World, type WorldPosition } from "../../geometry/coordinate.js";
import { rangeOverlapsHit } from "../../geometry/intersection.js";
import {
    advanceBattlefield,
    appendEvents,
    battlefieldView,
    getUnit,
    type BattleState,
} from "../../battle/state.js";
import { emptyCall, type CallContext } from "../../battle/execution/call.js";
import type { Unit, UnitId } from "../../unit/unit.js";
import { hasHit } from "../../unit/capability/spatial.js";
import { isSpatiallyPresent } from "../../unit/capability/presence.js";
import type { ProjectileQueryContext, ProjectileServices } from "./context.js";
import type { ProjectileDefinition } from "./definition.js";
import type { ProjectileId, Projectile, ProjectileStopReason } from "./projectile.js";

export type ProjectileSignal = {
    readonly projectileId: ProjectileId;
    readonly source: UnitId | null;
    readonly tick: number;
    readonly position: WorldPosition;
} & (
    | { readonly type: "PROJECTILE_REACHED" }
    | { readonly type: "PROJECTILE_HIT"; readonly targetUnitId: UnitId }
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

function signalFacts(projectile: Projectile, tick: number): Omit<ProjectileSignal, "type"> {
    return {
        projectileId: projectile.id,
        source: projectile.source,
        tick,
        position: projectile.position,
    };
}

function inContactArea(projectile: Projectile, target: Unit): boolean {
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
    definition: ProjectileDefinition<S>,
    tick: number,
    call: CallContext,
): BattleState {
    if (definition.contact === undefined) {
        return state;
    }

    const candidates = [...battlefieldView(state).unitIds].sort((left, right) => left - right);

    for (const targetUnitId of candidates) {
        const current = getProjectile(state, projectile.id) as Projectile<S> | undefined;
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
        const latest = getProjectile(state, projectile.id) ?? contacted;
        state = appendEvents(state, [
            { ...signalFacts(latest, tick), type: "PROJECTILE_HIT", targetUnitId },
        ]);
    }

    return state;
}

export function stopProjectile(
    state: BattleState,
    id: ProjectileId,
    services: ProjectileServices,
    tick: number,
    reason: ProjectileStopReason = "EXPLICIT",
    call: CallContext = emptyCall,
): BattleState {
    const current = getProjectile(state, id);

    if (current === undefined || current.progress.type === "STOPPED") {
        return state;
    }

    const stopped: Projectile = { ...current, progress: { type: "STOPPED", reason } };
    state = replaceProjectile(state, stopped);
    state = appendEvents(state, [
        { ...signalFacts(stopped, tick), type: "PROJECTILE_STOPPED", reason },
    ]);
    state = services.projectiles.withDefinition(stopped, (projectile, definition) =>
        definition.stop === undefined
            ? state
            : definition.stop(state, projectileContext(state, projectile, tick, call)),
    );

    return getProjectile(state, id) === undefined
        ? state
        : advanceBattlefield(state, [{ type: "REMOVE_PROJECTILE", projectileId: id }]);
}

function advanceProjectile(
    state: BattleState,
    id: ProjectileId,
    services: ProjectileServices,
    tick: number,
    call: CallContext,
): BattleState {
    const current = getProjectile(state, id);

    if (current === undefined || current.lastAdvancedTick >= tick) {
        return state;
    }
    if (current.expiresAtTick !== null && tick >= current.expiresAtTick) {
        return stopProjectile(state, id, services, tick, "EXPIRED", call);
    }
    switch (current.progress.type) {
        case "STOPPED":
            return state;

        case "WAITING_TO_STOP":
            return tick >= current.progress.targetTick
                ? stopProjectile(state, id, services, tick, "ARRIVED", call)
                : replaceProjectile(state, { ...current, lastAdvancedTick: tick });

        case "FLYING": {
            const target =
                current.traceTarget === null ? undefined : getUnit(state, current.traceTarget);
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

            const advanced: Projectile = {
                ...current,
                position,
                destination,
                lastAdvancedTick: tick,
                ...(reached ? { progress: { type: "WAITING_TO_STOP", targetTick } as const } : {}),
            };
            state = replaceProjectile(state, advanced);

            if (reached) {
                state = appendEvents(state, [
                    { ...signalFacts(advanced, tick), type: "PROJECTILE_REACHED" },
                ]);
                state = services.projectiles.withDefinition(advanced, (projectile, definition) =>
                    contact(state, projectile, definition, tick, call),
                );

                if (current.stopDelayTicks === 0) {
                    state = stopProjectile(state, id, services, tick, "ARRIVED", call);
                }
            }

            return state;
        }
    }
}

export function advanceProjectiles(
    state: BattleState,
    services: ProjectileServices,
    tick: number,
    stopIds: readonly ProjectileId[] = [],
    call: CallContext = emptyCall,
): BattleState {
    for (const id of stopIds) {
        state = stopProjectile(state, id, services, tick, "EXPLICIT", call);
    }

    const ids = [...battlefieldView(state).projectileIds].sort((left, right) => left - right);

    for (const id of ids) {
        state = advanceProjectile(state, id, services, tick, call);
    }

    return state;
}
