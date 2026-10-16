import { assertNonnegativeSafeInteger } from "../../../../common/assert.js";
import type { Definition as UnitDefinition, Unit } from "../../unit.js";
import * as registry from "../../hook/hook.js";
import * as contribution from "../../contribution/contribution.js";
import type { State as BattleState, Result } from "../../../battle/state.js";
import type { Activation, Definition as ActivationDefinition } from "./activation.js";
import type { Events, Hook, Key } from "./hook.js";
import type { Input as AmmoInput } from "./ammo.js";
import type { Modifier } from "./modifier.js";
import type { Rule } from "./rule.js";
import type { Instance } from "./instance.js";
import * as sp from "./sp.js";
import * as sustain from "./sustain.js";

export interface Definition<S extends object = object, A extends object = object> {
    readonly id: string;
    readonly initialize: () => S;
    readonly sp: sp.Definition | null;
    readonly activation: ActivationDefinition<S, A> | null;
    readonly onEnter?: (battle: BattleState, self: Instance<S, A>) => BattleState;
    readonly onTick?: (battle: BattleState, self: Instance<S, A>) => BattleState;
}

export interface State {
    readonly data: object;
    readonly sp: sp.State | null;
    readonly active: Activation | null;
    readonly nextActivationId: number;
    readonly sustain: sustain.Contributions | null;
    readonly rules: readonly Rule[];
    readonly spRecovered: readonly Hook<Events["spRecovered"]>[];
    readonly spPaid: readonly Hook<Events["spPaid"]>[];
    readonly spModified: readonly Hook<Events["spModified"]>[];
    readonly ammoConsumed: readonly Hook<Events["ammoConsumed"]>[];
    readonly ammoReplenished: readonly Hook<Events["ammoReplenished"]>[];
    readonly activated: readonly Hook<Events["activated"]>[];
    readonly ended: readonly Hook<Events["ended"]>[];
}

type Declaration = Pick<Definition, "id" | "initialize" | "sp"> & {
    readonly activation: {
        readonly trigger: ActivationDefinition<object, object>["trigger"];
        readonly sustain: sustain.Definition;
        readonly initialize: (battle: BattleState, self: never) => object;
    } | null;
};

export interface Skill {
    readonly definition: { readonly skill: Declaration };
    readonly skill: State;
}

export function hasSkill<U extends Unit>(unit: U): unit is U & Skill {
    return "skill" in unit && "skill" in unit.definition;
}

export function hasSkillDefinition(
    definition: UnitDefinition,
): definition is UnitDefinition & Skill["definition"] {
    return "skill" in definition;
}

export function createDefinition<S extends object, A extends object>(
    definition: Definition<S, A>,
): Definition<S, A> {
    if (definition.id.length === 0) {
        throw new TypeError("skill identity must be nonempty");
    }
    if (definition.sp !== null) {
        sp.validateDefinition(definition.sp);
    }

    const policy = definition.activation?.sustain;

    if (policy?.type === "TIME") {
        assertNonnegativeSafeInteger(policy.durationTicks, "skill duration ticks");
    } else if (policy?.type === "AMMO") {
        assertNonnegativeSafeInteger(policy.amount, "skill ammunition");
    }

    return Object.freeze({ ...definition });
}

export function initialize(
    battle: BattleState,
    definition: Skill["definition"]["skill"],
): Result<State> {
    const value: State = {
        data: definition.initialize(),
        sp: definition.sp === null ? null : sp.initialize(definition.sp, battle.tick),
        active: null,
        nextActivationId: 0,
        sustain:
            definition.activation === null
                ? null
                : sustain.initialize(definition.activation.sustain),
        rules: [
            {
                id: "@skill/active-recovery",
                allowsRecovery: allowsInactiveRecovery,
            },
        ],
        spRecovered: [],
        spPaid: [],
        spModified: [],
        ammoConsumed: [],
        ammoReplenished: [],
        activated: [],
        ended: [],
    };

    return { state: battle, value };
}

function allowsInactiveRecovery(_battle: BattleState, self: Unit & Skill): boolean {
    return self.skill.active === null;
}

export function setRule(state: State, rule: Rule): State {
    const rules = registry.set(state.rules, rule);

    return rules === state.rules ? state : { ...state, rules };
}

export function removeRule(state: State, id: string): State {
    const rules = registry.remove(state.rules, id);

    return rules === state.rules ? state : { ...state, rules };
}

export function setHook<K extends Key>(state: State, key: K, hook: Hook<Events[K]>): State {
    const hooks = registry.set(state[key] as readonly Hook<Events[K]>[], hook);

    return hooks === state[key] ? state : { ...state, [key]: hooks };
}

export function removeHook(state: State, key: Key, id: string): State {
    const hooks = state[key].filter((hook) => hook.id !== id);

    return hooks.length === state[key].length ? state : { ...state, [key]: hooks };
}

export function setSpRecoveredHook(state: State, hook: Hook<Events["spRecovered"]>): State {
    return setHook(state, "spRecovered", hook);
}

export function removeSpRecoveredHook(state: State, id: string): State {
    return removeHook(state, "spRecovered", id);
}

export function setSpPaidHook(state: State, hook: Hook<Events["spPaid"]>): State {
    return setHook(state, "spPaid", hook);
}

export function removeSpPaidHook(state: State, id: string): State {
    return removeHook(state, "spPaid", id);
}

export function setSpModifiedHook(state: State, hook: Hook<Events["spModified"]>): State {
    return setHook(state, "spModified", hook);
}

export function removeSpModifiedHook(state: State, id: string): State {
    return removeHook(state, "spModified", id);
}

export function setAmmoConsumedHook(state: State, hook: Hook<Events["ammoConsumed"]>): State {
    return setHook(state, "ammoConsumed", hook);
}

export function removeAmmoConsumedHook(state: State, id: string): State {
    return removeHook(state, "ammoConsumed", id);
}

export function setAmmoReplenishedHook(state: State, hook: Hook<Events["ammoReplenished"]>): State {
    return setHook(state, "ammoReplenished", hook);
}

export function removeAmmoReplenishedHook(state: State, id: string): State {
    return removeHook(state, "ammoReplenished", id);
}

export function setActivatedHook(state: State, hook: Hook<Events["activated"]>): State {
    return setHook(state, "activated", hook);
}

export function removeActivatedHook(state: State, id: string): State {
    return removeHook(state, "activated", id);
}

export function setEndedHook(state: State, hook: Hook<Events["ended"]>): State {
    return setHook(state, "ended", hook);
}

export function removeEndedHook(state: State, id: string): State {
    return removeHook(state, "ended", id);
}

export function setAmmoContribution(
    state: State,
    entry: contribution.Contribution<AmmoInput>,
): State {
    const current = state.sustain;

    if (current?.type !== "AMMO") {
        return state;
    }

    const ammo = contribution.set(current.ammo, entry);

    return ammo === current.ammo ? state : { ...state, sustain: { ...current, ammo } };
}

export function removeAmmoContribution(state: State, id: string): State {
    const current = state.sustain;

    if (current?.type !== "AMMO") {
        return state;
    }

    const ammo = contribution.remove(current.ammo, id);

    return ammo === current.ammo ? state : { ...state, sustain: { ...current, ammo } };
}

export function setDurationContribution(
    state: State,
    entry: contribution.Contribution<Modifier>,
): State {
    const current = state.sustain;

    if (current?.type !== "TIME") {
        return state;
    }

    const duration = contribution.set(current.duration, entry);

    return duration === current.duration ? state : { ...state, sustain: { ...current, duration } };
}

export function removeDurationContribution(state: State, id: string): State {
    const current = state.sustain;

    if (current?.type !== "TIME") {
        return state;
    }

    const duration = contribution.remove(current.duration, id);

    return duration === current.duration ? state : { ...state, sustain: { ...current, duration } };
}

export function validateState(state: State): void {
    assertNonnegativeSafeInteger(state.nextActivationId, "skill activation allocation progress");

    if (state.sp !== null) {
        assertNonnegativeSafeInteger(state.sp.value, "skill SP");
    }
    if (state.active !== null) {
        assertNonnegativeSafeInteger(state.active.id, "skill activation identity");

        if (state.active.id >= state.nextActivationId) {
            throw new TypeError("skill allocation progress must exceed its active identity");
        }
        if (
            state.active.sustain.type === "AMMO" &&
            !Number.isSafeInteger(state.active.sustain.remaining)
        ) {
            throw new TypeError("skill ammunition must be a safe integer");
        }
    }
}
