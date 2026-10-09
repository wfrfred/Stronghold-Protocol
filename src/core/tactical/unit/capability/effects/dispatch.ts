import type { UnitId } from "../../unit.js";
import { hasEffects } from "./capability.js";
import type { EffectView } from "./contract.js";
import {
    lifetimeKey,
    type LifetimeRef,
    type EffectRef,
    type EffectInstanceValue,
} from "./instance.js";
import type { CombatWork } from "../../../battle/execution/work.js";
import { isParticipatingEffect } from "./query.js";

interface ActiveInstance {
    instance: EffectInstanceValue;
}

export class EffectDispatchScope {
    readonly #closing = new Set<string>();
    readonly #pendingEnds = new Map<string, EffectRef>();
    readonly #deferredRemovals = new Map<UnitId, (work: CombatWork) => CombatWork>();

    markClosing(lifetimes: readonly LifetimeRef[]): void {
        for (const lifetime of lifetimes) {
            this.#closing.add(lifetimeKey(lifetime));
        }
    }

    isClosing(lifetime: LifetimeRef): boolean {
        return this.#closing.has(lifetimeKey(lifetime));
    }

    beginEnds(refs: readonly EffectRef[]): void {
        this.markClosing(refs);

        for (const ref of refs) {
            this.#pendingEnds.set(lifetimeKey(ref), ref);
        }
    }

    completeEnd(ref: EffectRef): void {
        this.#pendingEnds.delete(lifetimeKey(ref));
    }

    hasPendingEnd(ref: EffectRef): boolean {
        return this.#pendingEnds.has(lifetimeKey(ref));
    }

    hasPendingEnds(unitId: UnitId): boolean {
        return [...this.#pendingEnds.values()].some((ref) => ref.unitId === unitId);
    }

    deferUnitRemoval(unitId: UnitId, finish: (work: CombatWork) => CombatWork): void {
        if (!this.#deferredRemovals.has(unitId)) {
            this.#deferredRemovals.set(unitId, finish);
        }
    }

    drainDeferred(work: CombatWork): CombatWork {
        for (const [unitId, finish] of this.#deferredRemovals) {
            if (this.hasPendingEnds(unitId)) {
                continue;
            }

            this.#deferredRemovals.delete(unitId);
            work = finish(work);
        }

        return work;
    }

    readonly #candidates = new Map<UnitId, readonly EffectRef[]>();
    readonly #activeInstances = new Map<UnitId, Map<number, Set<ActiveInstance>>>();
    readonly #participationChanges = new Map<
        UnitId,
        Map<number, { pending: boolean; participating: boolean }>
    >();

    withParticipationChanges<T>(
        changes: readonly { address: EffectRef; participating: boolean }[],
        run: (isPending: (index: number) => boolean) => T,
    ): T {
        const cells = changes.map(({ address, participating }) => {
            let instances = this.#participationChanges.get(address.unitId);

            if (instances === undefined) {
                instances = new Map();
                this.#participationChanges.set(address.unitId, instances);
            }

            const previous = instances.get(address.effectId);

            if (previous !== undefined) {
                previous.pending = false;
            }

            const cell = { pending: true, participating };
            instances.set(address.effectId, cell);

            return cell;
        });

        try {
            return run((index) => cells[index]!.pending);
        } finally {
            for (const [index, { address }] of changes.entries()) {
                const instances = this.#participationChanges.get(address.unitId);
                const cell = cells[index]!;
                cell.pending = false;

                if (instances?.get(address.effectId) === cell) {
                    instances.delete(address.effectId);
                }
                if (instances?.size === 0) {
                    this.#participationChanges.delete(address.unitId);
                }
            }
        }
    }

    consumeParticipationChange(address: EffectRef, participating: boolean): boolean {
        const cell = this.#participationChanges.get(address.unitId)?.get(address.effectId);

        if (cell?.pending !== true || cell.participating !== participating) {
            return false;
        }

        cell.pending = false;

        return true;
    }

    withInstance<T>(
        address: EffectRef,
        instance: EffectInstanceValue,
        run: (lastKnown: () => EffectInstanceValue) => T,
    ): T {
        let instances = this.#activeInstances.get(address.unitId);

        if (instances === undefined) {
            instances = new Map();
            this.#activeInstances.set(address.unitId, instances);
        }

        let active = instances.get(address.effectId);

        if (active === undefined) {
            active = new Set();
            instances.set(address.effectId, active);
        }

        const cell = { instance };
        active.add(cell);

        try {
            return run(() => cell.instance);
        } finally {
            active.delete(cell);

            if (active.size === 0) {
                instances.delete(address.effectId);
            }
            if (instances.size === 0) {
                this.#activeInstances.delete(address.unitId);
            }
        }
    }

    retainFinalizedInstance(address: EffectRef, instance: EffectInstanceValue): void {
        const active = this.#activeInstances.get(address.unitId)?.get(address.effectId);

        if (active === undefined) {
            return;
        }

        for (const cell of active) {
            cell.instance = instance;
        }
    }

    withCandidates<T>(
        facts: EffectView,
        unitId: UnitId,
        run: (candidates: readonly EffectRef[]) => T,
    ): T {
        const existing = this.#candidates.get(unitId);

        if (existing !== undefined) {
            return run(existing);
        }

        const unit = facts.getUnit(unitId);
        const candidates = Object.freeze(
            unit !== undefined && hasEffects(unit)
                ? unit.effects.instances.map((instance) =>
                      Object.freeze({ type: "EFFECT" as const, unitId, effectId: instance.id }),
                  )
                : [],
        );

        this.#candidates.set(unitId, candidates);

        try {
            return run(candidates);
        } finally {
            this.#candidates.delete(unitId);
        }
    }
}

export function participatingEffect(
    facts: EffectView,
    address: EffectRef,
): EffectInstanceValue | undefined {
    const instance = facts.getEffect(address);

    return instance !== undefined && isParticipatingEffect(instance) ? instance : undefined;
}
