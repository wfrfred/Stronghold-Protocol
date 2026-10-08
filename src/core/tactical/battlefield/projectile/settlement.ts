import {
    withProjectileContext,
    withProjectileQuery,
    type ProjectileContextAccess,
} from "./internal/context.js";
import { ProjectileWork, updateProjectileInstance } from "./internal/state.js";
import { World, type WorldPosition } from "../../geometry/coordinate.js";
import { rangeOverlapsHit } from "../../geometry/intersection.js";
import {
    appendCombatEvents,
    combatWorkView,
    getCombatUnit,
    type CombatWork,
} from "../../battle/execution/work.js";
import type { Unit, UnitId } from "../../unit/unit.js";
import { hasHit } from "../../unit/capability/spatial.js";
import { isSpatiallyPresent } from "../../unit/capability/presence.js";
import type { ProjectileContactContext, ProjectileServices } from "./context.js";
import type { ProjectileProgram } from "./program.js";
import {
    type ProjectileId,
    type ProjectileInstance,
    type ProjectileState,
    type ProjectileStopReason,
} from "./state.js";

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

export interface ProjectileTransition {
    readonly work: CombatWork;
    readonly state: ProjectileState;
}

class ProjectileSettlement {
    work: CombatWork;
    readonly #projectiles: ProjectileWork;
    readonly #services: ProjectileServices;
    readonly #tick: number;
    readonly #lastKnown = new Map<ProjectileId, ProjectileInstance>();

    constructor(
        work: CombatWork,
        state: ProjectileState,
        services: ProjectileServices,
        tick: number,
    ) {
        this.work = work;
        this.#projectiles = new ProjectileWork(state);
        this.#services = services;
        this.#tick = tick;
    }

    #get(id: ProjectileId): ProjectileInstance | undefined {
        return this.#projectiles.get(id);
    }

    #update(instance: ProjectileInstance): void {
        this.#lastKnown.set(instance.id, instance);
        this.#projectiles.update(instance);
    }

    #signal(instance: ProjectileInstance, signal: ProjectileSignal): void {
        this.#lastKnown.set(instance.id, instance);
        this.work = appendCombatEvents(this.work, [signal]);
    }

    #signalFacts(instance: ProjectileInstance): Omit<ProjectileSignal, "type"> {
        return {
            projectileId: instance.id,
            source: instance.source,
            tick: this.#tick,
            position: instance.position,
        };
    }

    #contextAccess(): ProjectileContextAccess {
        return {
            getWork: () => this.work,
            setWork: (work) => {
                this.work = work;
            },
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

    #inContactArea(instance: ProjectileInstance, target: Unit): boolean {
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
        instance: ProjectileInstance<S>,
        program: ProjectileProgram<S>,
        target: Unit,
    ): boolean {
        return (
            this.#inContactArea(instance, target) &&
            !instance.hitUnitIds.includes(target.id) &&
            withProjectileQuery(instance, this.#contextAccess(), this.#tick, (context) =>
                program.acceptsContact(context, target),
            )
        );
    }

    #contact<S extends object>(
        instance: ProjectileInstance<S>,
        program: ProjectileProgram<S>,
    ): void {
        if (program.contact === undefined) {
            return;
        }

        const candidates = [...combatWorkView(this.work).unitIds].sort(
            (left, right) => left - right,
        );

        for (const targetUnitId of candidates) {
            const current = this.#get(instance.id) as ProjectileInstance<S> | undefined;
            const target = getCombatUnit(this.work, targetUnitId);

            if (current === undefined || current.progress.type === "STOPPED") {
                return;
            }
            if (target === undefined || !this.#accepts(current, program, target)) {
                continue;
            }

            const contacted = updateProjectileInstance(current, {
                hitUnitIds: Object.freeze([...current.hitUnitIds, targetUnitId]),
            });
            this.#update(contacted);

            withProjectileContext(
                contacted,
                program,
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

                    const invoke: (context: ProjectileContactContext<S>) => unknown =
                        program.contact!;

                    return invoke(contact);
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

        const stopped = updateProjectileInstance(current, {
            progress: Object.freeze({ type: "STOPPED", reason }),
        });
        this.#update(stopped);
        this.#signal(stopped, {
            ...this.#signalFacts(stopped),
            type: "PROJECTILE_STOPPED",
            reason,
        });

        this.#services.projectiles.withProgram(stopped, (instance, program) => {
            if (program.stop !== undefined) {
                withProjectileContext(
                    instance,
                    program,
                    this.#services,
                    this.#contextAccess(),
                    this.#tick,
                    program.stop,
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
                    this.#update(
                        updateProjectileInstance(current, { lastAdvancedTick: this.#tick }),
                    );
                }

                return;

            case "FLYING": {
                const target =
                    current.traceTarget === null
                        ? undefined
                        : getCombatUnit(this.work, current.traceTarget);
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

                const advanced = updateProjectileInstance(current, {
                    position,
                    destination,
                    lastAdvancedTick: this.#tick,
                    ...(reached
                        ? { progress: Object.freeze({ type: "WAITING_TO_STOP", targetTick }) }
                        : {}),
                });
                this.#update(advanced);

                if (reached) {
                    this.#signal(advanced, {
                        ...this.#signalFacts(advanced),
                        type: "PROJECTILE_REACHED",
                    });
                    this.#services.projectiles.withProgram(advanced, (instance, program) => {
                        this.#contact(instance, program);
                    });

                    if (current.stopDelayTicks === 0) {
                        this.stop(id, "ARRIVED");
                    }
                }

                return;
            }
        }
    }

    result(): ProjectileTransition {
        return { work: this.work, state: this.#projectiles.result() };
    }

    advanceAll(): void {
        const ids = [...this.#projectiles.ids].sort((left, right) => left - right);

        for (const id of ids) {
            this.advance(id);
        }
    }
}

export function stepProjectiles(
    work: CombatWork,
    state: ProjectileState,
    services: ProjectileServices,
    tick: number,
    stopIds: readonly ProjectileId[] = [],
): ProjectileTransition {
    const settlement = new ProjectileSettlement(work, state, services, tick);

    for (const id of stopIds) {
        settlement.stop(id, "EXPLICIT");
    }

    settlement.advanceAll();

    return settlement.result();
}

export function stopProjectile(
    work: CombatWork,
    state: ProjectileState,
    id: ProjectileId,
    services: ProjectileServices,
    tick: number,
    reason: ProjectileStopReason = "EXPLICIT",
): ProjectileTransition {
    const settlement = new ProjectileSettlement(work, state, services, tick);
    settlement.stop(id, reason);

    return settlement.result();
}
