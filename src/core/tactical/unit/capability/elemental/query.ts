import type { Ref } from "../../../../common/ref.js";
import { updateUnit, type State as BattleState } from "../../../battle/state.js";
import type { Unit } from "../../unit.js";
import * as units from "../../query.js";
import * as contribution from "../../contribution/contribution.js";
import * as modifier from "../../contribution/value.js";
import { hasAllegiance } from "../allegiance/capability.js";
import { isSpatiallyPresent } from "../presence/capability.js";
import { hasVitality } from "../vitality/capability.js";
import {
    ELEMENT_TYPES,
    hasElemental,
    type Elemental,
    type Parameter,
    type Type,
} from "./capability.js";
import type { Burst } from "./burst.js";
import type { DamageRequest, HealRequest } from "./operations.js";

export function get(battle: BattleState, reference: Ref<Burst>): Burst | undefined {
    const burst = units.get(battle, reference.host)?.elemental.burst;

    return burst?.id === reference.id ? burst : undefined;
}

export function replace(battle: BattleState, self: Unit & Elemental): BattleState {
    const current = units.get(battle, units.ref(self));

    return current?.definition.elemental === self.definition.elemental
        ? updateUnit(battle, self)
        : battle;
}

export function resolveMaxEp(battle: BattleState, host: Ref<Unit & Elemental>): number | undefined {
    return resolve(battle, host, "maxEp");
}

export function resolveRecoverySpeed(
    battle: BattleState,
    host: Ref<Unit & Elemental>,
): number | undefined {
    return resolve(battle, host, "recoverySpeed");
}

export function resolveElementResistance(
    battle: BattleState,
    host: Ref<Unit & Elemental>,
): number | undefined {
    return resolve(battle, host, "elementResistance");
}

export function resolveDamageResistance(
    battle: BattleState,
    host: Ref<Unit & Elemental>,
): number | undefined {
    return resolve(battle, host, "damageResistance");
}

export function resolveBurstRecoverySpeed(
    battle: BattleState,
    host: Ref<Unit & Elemental>,
): number | undefined {
    return resolve(battle, host, "burstRecoverySpeed");
}

function resolve(
    battle: BattleState,
    host: Ref<Unit & Elemental>,
    parameter: Parameter,
): number | undefined {
    const self = units.get(battle, host);

    if (self === undefined || !hasElemental(self)) {
        return undefined;
    }

    const base =
        parameter === "recoverySpeed"
            ? self.definition.elemental.recoveryPerSecond
            : self.definition.elemental[parameter];
    const value = modifier.apply(
        base,
        contribution.resolve(self.elemental[parameter], (input) =>
            typeof input === "function" ? input(battle, self) : input,
        ),
    );

    if (parameter === "maxEp") {
        return Math.max(1, value);
    }
    if (parameter === "elementResistance" || parameter === "damageResistance") {
        return Math.min(95, Math.max(0, value));
    }

    return Math.max(0, value);
}

export function available(self: Unit): boolean {
    return (
        self.lifecycle === "PRESENT" &&
        isSpatiallyPresent(self) &&
        (!hasVitality(self) || self.vitality.hp > 0)
    );
}

export function damageRejection(
    battle: BattleState,
    host: Ref<Unit>,
    request: DamageRequest,
): string | undefined {
    const self = units.get(battle, host);

    if (self === undefined) {
        return "TARGET_ABSENT";
    }
    if (!hasElemental(self)) {
        return "NO_ELEMENTAL";
    }
    if (!available(self)) {
        return "INACTIVE";
    }
    if (self.elemental.burst !== null) {
        return "RECOVERING";
    }
    if (hasAllegiance(self) && self.allegiance.side === "NEUTRAL") {
        return "NEUTRAL";
    }

    return self.elemental.rules.every((rule) => rule.allowsDamage?.(battle, self, request) ?? true)
        ? undefined
        : "RULE";
}

export function healRejection(
    battle: BattleState,
    host: Ref<Unit>,
    request: HealRequest,
): string | undefined {
    const self = units.get(battle, host);

    if (self === undefined) {
        return "TARGET_ABSENT";
    }
    if (!hasElemental(self)) {
        return "NO_ELEMENTAL";
    }
    if (!available(self)) {
        return "INACTIVE";
    }
    if (self.elemental.burst !== null) {
        return "RECOVERING";
    }

    return self.elemental.rules.every((rule) => rule.allowsHeal?.(battle, self, request) ?? true)
        ? undefined
        : "RULE";
}

export function canReceiveDamage(
    battle: BattleState,
    host: Ref<Unit>,
    request: DamageRequest,
): boolean {
    return damageRejection(battle, host, request) === undefined;
}

export function canReceiveHeal(
    battle: BattleState,
    host: Ref<Unit>,
    request: HealRequest,
): boolean {
    return healRejection(battle, host, request) === undefined;
}

export function currentType(self: Unit, maxEp?: number): Type | undefined {
    if (!hasElemental(self)) {
        return undefined;
    }

    let selected: Type | undefined;
    let minimum = maxEp ?? self.definition.elemental.maxEp;

    for (const type of ELEMENT_TYPES) {
        if (self.elemental.ep[type] < minimum) {
            selected = type;
            minimum = self.elemental.ep[type];
        }
    }

    return selected;
}

export function damageRatio(self: Unit, maxEp?: number): number {
    if (!hasElemental(self)) {
        return 0;
    }

    const maximum = maxEp ?? self.definition.elemental.maxEp;
    const type = currentType(self, maximum);

    return type === undefined ? 0 : Math.min(1, Math.max(0, 1 - self.elemental.ep[type] / maximum));
}

export function resolveDamageRatio(
    battle: BattleState,
    host: Ref<Unit & Elemental>,
): number | undefined {
    const self = units.get(battle, host);

    return self === undefined ? undefined : damageRatio(self, resolveMaxEp(battle, host));
}
