import type { UnitId } from "../../unit.js";
import { hasEffects } from "./capability.js";
import type { EffectView } from "./contract.js";
import { lifetimeKey, type LifetimeRef, type EffectRef, type EffectValue } from "./effect.js";
import { isParticipatingEffect } from "./query.js";

interface ActiveEffect {
    instance: EffectValue;
}

export class EffectDispatchScope {
    readonly #closing = new Set<string>();
    readonly #pendingEnds = new Set<string>();
    readonly #deferredRemovals = new Map<UnitId, () => void>();

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
            this.#pendingEnds.add(lifetimeKey(ref));
        }
    }

    completeEnd(ref: EffectRef): void {
        this.#pendingEnds.delete(lifetimeKey(ref));
    }

    hasPendingEnd(ref: EffectRef): boolean {
        return this.#pendingEnds.has(lifetimeKey(ref));
    }

    hasPendingEnds(): boolean {
        return this.#pendingEnds.size > 0;
    }

    deferUnitRemoval(unitId: UnitId, finish: () => void): void {
        if (!this.#deferredRemovals.has(unitId)) {
            this.#deferredRemovals.set(unitId, finish);
        }
    }

    drainDeferred(): void {
        // Remote dependents can still be notifying even after their host's notices finish.
        if (this.hasPendingEnds()) {
            return;
        }
        for (const [unitId, finish] of this.#deferredRemovals) {
            this.#deferredRemovals.delete(unitId);
            finish();
        }
    }

    readonly #candidates = new Map<UnitId, readonly EffectRef[]>();
    readonly #activeEffects = new Map<UnitId, Map<number, Set<ActiveEffect>>>();
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

    withEffect<T>(
        address: EffectRef,
        instance: EffectValue,
        run: (lastKnown: () => EffectValue) => T,
    ): T {
        let instances = this.#activeEffects.get(address.unitId);

        if (instances === undefined) {
            instances = new Map();
            this.#activeEffects.set(address.unitId, instances);
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
                this.#activeEffects.delete(address.unitId);
            }
        }
    }

    retainFinalizedEffect(address: EffectRef, instance: EffectValue): void {
        const active = this.#activeEffects.get(address.unitId)?.get(address.effectId);

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
): EffectValue | undefined {
    const instance = facts.getEffect(address);

    return instance !== undefined && isParticipatingEffect(instance) ? instance : undefined;
}
