import type { Ref } from "../../../../common/ref.js";
import { updateUnit, type State as BattleState } from "../../../battle/state.js";
import type { Unit } from "../../unit.js";
import * as units from "../../query.js";
import type { Definition, Skill } from "./capability.js";
import type { Activation } from "./activation.js";

export function get<T extends Activation>(battle: BattleState, reference: Ref<T>): T | undefined;
export function get<S extends object, A extends object>(
    battle: BattleState,
    reference: Ref<Activation>,
    definition: Definition<S, A>,
): Activation<A> | undefined;
export function get<T extends Activation>(
    battle: BattleState,
    reference: Ref<T>,
    definition?: Skill["definition"]["skill"],
): Activation | undefined {
    const self = units.get(battle, reference.host);

    return self?.skill.active?.id === reference.id &&
        (definition === undefined || self.definition.skill === definition)
        ? self.skill.active
        : undefined;
}

export function replace(battle: BattleState, self: Unit & Skill): BattleState {
    return updateUnit(battle, self);
}

export function replaceActivation<A extends object>(
    battle: BattleState,
    reference: Ref<Activation<A>>,
    self: NoInfer<Activation<A>>,
): BattleState {
    const host = units.get(battle, reference.host);

    if (host?.skill.active?.id !== reference.id || host.skill.active.status === "ENDING") {
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
