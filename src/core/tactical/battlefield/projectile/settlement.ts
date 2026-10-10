import {
    withProjectileContext,
    withProjectileQuery,
    type ProjectileContextAccess,
} from "./internal/context.js";
import { ProjectileWork, updateProjectile } from "./internal/state.js";
import { World, type WorldPosition } from "../../geometry/coordinate.js";
import { rangeOverlapsHit } from "../../geometry/intersection.js";
import {
    advanceBattlefield,
    appendEvents,
    battlefieldView,
    getUnit,
    type BattleState,
} from "../../battle/execution/context.js";
import type { Unit, UnitId } from "../../unit/unit.js";
import { hasHit } from "../../unit/capability/spatial.js";
import { isSpatiallyPresent } from "../../unit/capability/presence.js";
import type { ProjectileContactContext, ProjectileServices } from "./context.js";
import type { ProjectileDefinition } from "./definition.js";
import { type ProjectileId, type Projectile, type ProjectileStopReason } from "./projectile.js";

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

class ProjectileSettlement {
    readonly #state: BattleState;
    readonly #projectiles: ProjectileWork;
    readonly #services: ProjectileServices;
    readonly #tick: number;
    readonly #lastKnown = new Map<ProjectileId, Projectile>();

    constructor(work: BattleState, services: ProjectileServices, tick: number) {
        this.#state = work;
        this.#projectiles = new ProjectileWork(battlefieldView(work));
        this.#services = services;
        this.#tick = tick;
    }

    #get(id: ProjectileId): Projectile | undefined {
        return this.#projectiles.get(id);
    }

    #update(instance: Projectile): void {
        this.#lastKnown.set(instance.id, instance);
        this.#projectiles.update(instance);
    }

    #signal(instance: Projectile, signal: ProjectileSignal): void {
        this.#lastKnown.set(instance.id, instance);
        appendEvents(this.#state, [signal]);
    }

    #signalFacts(instance: Projectile): Omit<ProjectileSignal, "type"> {
        return {
            projectileId: instance.id,
            source: instance.source,
            tick: this.#tick,
            position: instance.position,
        };
    }

    #contextAccess(): ProjectileContextAccess {
        return {
            state: this.#state,
            getProjectile: (id) => this.#get(id),
            lastKnown: (id) => this.#lastKnown.get(id),
            save: (instance) => {
                if (this.#get(instance.id) !== undefined) {
                    this.#update(instance);
                } else {
                    this.#lastKnown.set(instance.id, instance);
                }
            },
            stop: (id, reason) => {
                this.stop(id, reason);
            },
        };
    }

    #inContactArea(instance: Projectile, target: Unit): boolean {
        return (
            isSpatiallyPresent(target) &&
            hasHit(target) &&
            rangeOverlapsHit(
                instance.contactRange,
                instance.position,
                target.position,
                target.hit.geometry,
            )
        );
    }

    #accepts<S extends object>(
        instance: Projectile<S>,
        definition: ProjectileDefinition<S>,
        target: Unit,
    ): boolean {
        return (
            this.#inContactArea(instance, target) &&
            !instance.hitUnitIds.includes(target.id) &&
            withProjectileQuery(instance, this.#contextAccess(), this.#tick, (context) =>
                definition.acceptsContact(context, target),
            )
        );
    }

    #contact<S extends object>(instance: Projectile<S>, definition: ProjectileDefinition<S>): void {
        if (definition.contact === undefined) {
            return;
        }

        const candidates = [...battlefieldView(this.#state).unitIds].sort(
            (left, right) => left - right,
        );

        for (const targetUnitId of candidates) {
            const current = this.#get(instance.id) as Projectile<S> | undefined;
            const target = getUnit(this.#state, targetUnitId);

            if (current === undefined || current.progress.type === "STOPPED") {
                return;
            }
            if (target === undefined || !this.#accepts(current, definition, target)) {
                continue;
            }

            const contacted = updateProjectile(current, {
                hitUnitIds: [...current.hitUnitIds, targetUnitId],
            });
            this.#update(contacted);

            withProjectileContext(
                contacted,
                this.#services,
                this.#contextAccess(),
                this.#tick,
                (context) => {
                    const contact: ProjectileContactContext<S> = {
                        get projectile() {
                            return context.projectile;
                        },
                        tick: context.tick,
                        facts: context.facts,
                        operations: context.operations,
                        attackPower: () => context.attackPower(),
                        targetUnitId,
                    };

                    definition.contact!(contact);
                },
            );

            const latest = this.#get(instance.id) ?? this.#lastKnown.get(instance.id) ?? contacted;

            this.#signal(latest, {
                ...this.#signalFacts(latest),
                type: "PROJECTILE_HIT",
                targetUnitId,
            });
        }
    }

    stop(id: ProjectileId, reason: ProjectileStopReason): void {
        const current = this.#get(id);

        if (current === undefined || current.progress.type === "STOPPED") {
            return;
        }

        const stopped = updateProjectile(current, {
            progress: { type: "STOPPED", reason },
        });
        this.#update(stopped);
        this.#signal(stopped, {
            ...this.#signalFacts(stopped),
            type: "PROJECTILE_STOPPED",
            reason,
        });

        this.#services.projectiles.withDefinition(stopped, (instance, definition) => {
            if (definition.stop !== undefined) {
                withProjectileContext(
                    instance,
                    this.#services,
                    this.#contextAccess(),
                    this.#tick,
                    definition.stop,
                );
            }
        });
        this.#projectiles.remove(id);
    }

    advance(id: ProjectileId): void {
        const current = this.#get(id);

        if (current === undefined || current.lastAdvancedTick >= this.#tick) {
            return;
        }
        if (current.expiresAtTick !== null && this.#tick >= current.expiresAtTick) {
            this.stop(id, "EXPIRED");

            return;
        }

        switch (current.progress.type) {
            case "STOPPED":
                return;

            case "WAITING_TO_STOP":
                if (this.#tick >= current.progress.targetTick) {
                    this.stop(id, "ARRIVED");
                } else {
                    this.#update(updateProjectile(current, { lastAdvancedTick: this.#tick }));
                }

                return;

            case "FLYING": {
                const target =
                    current.traceTarget === null
                        ? undefined
                        : getUnit(this.#state, current.traceTarget);
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
                const targetTick = this.#tick + current.stopDelayTicks;

                if (reached && !Number.isSafeInteger(targetTick)) {
                    throw new RangeError("projectile stop deadline overflow");
                }

                const advanced = updateProjectile(current, {
                    position,
                    destination,
                    lastAdvancedTick: this.#tick,
                    ...(reached ? { progress: { type: "WAITING_TO_STOP", targetTick } } : {}),
                });
                this.#update(advanced);

                if (reached) {
                    this.#signal(advanced, {
                        ...this.#signalFacts(advanced),
                        type: "PROJECTILE_REACHED",
                    });
                    this.#services.projectiles.withDefinition(advanced, (instance, definition) => {
                        this.#contact(instance, definition);
                    });

                    if (current.stopDelayTicks === 0) {
                        this.stop(id, "ARRIVED");
                    }
                }

                return;
            }
        }
    }

    commit(): void {
        advanceBattlefield(this.#state, this.#projectiles.changes());
    }

    advanceAll(): void {
        const ids = [...this.#projectiles.ids].sort((left, right) => left - right);

        for (const id of ids) {
            this.advance(id);
        }
    }
}

export function advanceProjectiles(
    work: BattleState,
    services: ProjectileServices,
    tick: number,
    stopIds: readonly ProjectileId[] = [],
): void {
    const settlement = new ProjectileSettlement(work, services, tick);

    for (const id of stopIds) {
        settlement.stop(id, "EXPLICIT");
    }

    settlement.advanceAll();

    settlement.commit();
}

export function stopProjectile(
    work: BattleState,
    id: ProjectileId,
    services: ProjectileServices,
    tick: number,
    reason: ProjectileStopReason = "EXPLICIT",
): void {
    const settlement = new ProjectileSettlement(work, services, tick);
    settlement.stop(id, reason);

    settlement.commit();
}
