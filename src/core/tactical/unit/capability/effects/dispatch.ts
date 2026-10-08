import type { UnitId } from "../../unit.js";
import { hasEffects } from "./capability.js";
import type { EffectView } from "./contract.js";
import type { EffectAddress, EffectInstanceValue } from "./instance.js";
import { isParticipatingEffect } from "./query.js";

interface ActiveInstance {
    instance: EffectInstanceValue;
}

export class EffectDispatchScope {
    readonly #candidates = new Map<UnitId, readonly EffectAddress[]>();
    readonly #activeInstances = new Map<UnitId, Map<number, Set<ActiveInstance>>>();
    readonly #participationChanges = new Map<
        UnitId,
        Map<number, { pending: boolean; participating: boolean }>
    >();

    withParticipationChanges<T>(
        changes: readonly { address: EffectAddress; participating: boolean }[],
        run: (isPending: (index: number) => boolean) => T,
    ): T {
        const cells = changes.map(({ address, participating }) => {
            let instances = this.#participationChanges.get(address.unitId);

            if (instances === undefined) {
                instances = new Map();
                this.#participationChanges.set(address.unitId, instances);
            }

            const previous = instances.get(address.instanceId);

            if (previous !== undefined) {
                previous.pending = false;
            }

            const cell = { pending: true, participating };
            instances.set(address.instanceId, cell);

            return cell;
        });

        try {
            return run((index) => cells[index]!.pending);
        } finally {
            for (const [index, { address }] of changes.entries()) {
                const instances = this.#participationChanges.get(address.unitId);
                const cell = cells[index]!;
                cell.pending = false;

                if (instances?.get(address.instanceId) === cell) {
                    instances.delete(address.instanceId);
                }
                if (instances?.size === 0) {
                    this.#participationChanges.delete(address.unitId);
                }
            }
        }
    }

    consumeParticipationChange(address: EffectAddress, participating: boolean): boolean {
        const cell = this.#participationChanges.get(address.unitId)?.get(address.instanceId);

        if (cell?.pending !== true || cell.participating !== participating) {
            return false;
        }

        cell.pending = false;

        return true;
    }

    withInstance<T>(
        address: EffectAddress,
        instance: EffectInstanceValue,
        run: (lastKnown: () => EffectInstanceValue) => T,
    ): T {
        let instances = this.#activeInstances.get(address.unitId);

        if (instances === undefined) {
            instances = new Map();
            this.#activeInstances.set(address.unitId, instances);
        }

        let active = instances.get(address.instanceId);

        if (active === undefined) {
            active = new Set();
            instances.set(address.instanceId, active);
        }

        const cell = { instance };
        active.add(cell);

        try {
            return run(() => cell.instance);
        } finally {
            active.delete(cell);

            if (active.size === 0) {
                instances.delete(address.instanceId);
            }
            if (instances.size === 0) {
                this.#activeInstances.delete(address.unitId);
            }
        }
    }

    retainFinalizedInstance(address: EffectAddress, instance: EffectInstanceValue): void {
        const active = this.#activeInstances.get(address.unitId)?.get(address.instanceId);

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
        run: (candidates: readonly EffectAddress[]) => T,
    ): T {
        const existing = this.#candidates.get(unitId);

        if (existing !== undefined) {
            return run(existing);
        }

        const unit = facts.getUnit(unitId);
        const candidates = Object.freeze(
            unit !== undefined && hasEffects(unit)
                ? unit.effects.instances.map((instance) =>
                      Object.freeze({ unitId, instanceId: instance.id }),
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
    address: EffectAddress,
): EffectInstanceValue | undefined {
    const instance = facts.getEffect(address);

    return instance !== undefined && isParticipatingEffect(instance) ? instance : undefined;
}
