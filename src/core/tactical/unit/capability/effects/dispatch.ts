import type { UnitId } from "../../unit.js";
import { hasEffects } from "./capability.js";
import type { EffectFacts } from "./contract.js";
import type { EffectAddress, EffectInstanceValue } from "./instance.js";
import { isParticipatingEffect } from "./query.js";

interface ActiveInstance {
    instance: EffectInstanceValue;
}

export class EffectDispatchScope {
    readonly #candidates = new Map<UnitId, readonly EffectAddress[]>();
    readonly #activeInstances = new Map<UnitId, Map<number, Set<ActiveInstance>>>();

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
        facts: EffectFacts,
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
    facts: EffectFacts,
    address: EffectAddress,
): EffectInstanceValue | undefined {
    const instance = facts.getEffect(address);

    return instance !== undefined && isParticipatingEffect(instance) ? instance : undefined;
}
