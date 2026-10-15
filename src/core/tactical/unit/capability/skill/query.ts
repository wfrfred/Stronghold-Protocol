import type { Ref } from "../../../../common/ref.js";
import { updateUnit, type State as BattleState } from "../../../battle/state.js";
import type { Unit } from "../../unit.js";
import * as units from "../../query.js";
import { hasSkill, type Skill, type Stored } from "./capability.js";
import type { Activation, Stored as StoredActivation } from "./activation.js";

export function get<T extends StoredActivation>(
    battle: BattleState,
    reference: Ref<T>,
): T | undefined {
    const self = units.get(battle, reference.host);

    return self?.skill.active?.id === reference.id ? (self.skill.active as T) : undefined;
}

export function read<R>(
    battle: BattleState,
    host: Ref<Unit & Stored>,
    reader: <S extends object, A extends object>(self: Unit & Skill<S, A>) => R,
): R | undefined {
    const self = units.get(battle, host);

    return self === undefined || !hasSkill(self)
        ? undefined
        : reader(self as unknown as Unit & Skill);
}

export function replace<S extends object, A extends object>(
    battle: BattleState,
    self: Unit & Skill<S, A>,
): BattleState {
    const current = units.get(battle, units.ref(self));

    if (current?.definition.skill !== self.definition.skill) {
        return battle;
    }

    return updateUnit(battle, self);
}

export function replaceActivation<S extends object, A extends object>(
    battle: BattleState,
    self: Activation<S, A>,
): BattleState {
    const host = units.get(battle, self.host);

    if (host?.skill.active?.id !== self.id) {
        return battle;
    }
    if (host.skill.active.status === "ENDING") {
        return battle;
    }
    if (self.status !== host.skill.active.status) {
        throw new TypeError("skill activation status requires a lifecycle operation");
    }
    if (host.skill.active.startedAtTick !== self.startedAtTick) {
        throw new TypeError("skill activation start tick cannot change");
    }

    return replace(battle, { ...host, skill: { ...host.skill, active: self } });
}
