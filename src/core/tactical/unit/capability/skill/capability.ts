import { assertNonnegativeSafeInteger } from "../../../../common/assert.js";
import type { Definition as UnitDefinition, Unit } from "../../unit.js";
import * as registry from "../../hook/hook.js";
import * as contribution from "../../contribution/contribution.js";
import type { State as BattleState, Result } from "../../../battle/state.js";
import type {
    Activation,
    Definition as ActivationDefinition,
    Stored as StoredActivation,
} from "./activation.js";
import type { Events, Hook, Key } from "./hook.js";
import type { Input } from "./input.js";
import type { Rule } from "./rule.js";
import * as sp from "./sp.js";
import * as sustain from "./sustain.js";

export interface Definition<S extends object = object, A extends object = object> {
    readonly id: string;
    readonly initialize: () => S;
    readonly sp: sp.Definition | null;
    readonly activation: ActivationDefinition<S, A> | null;
    readonly onEnter?: (battle: BattleState, self: Unit & Skill<S, A>) => BattleState;
    readonly onTick?: (battle: BattleState, self: Unit & Skill<S, A>) => BattleState;
}

export interface State<S extends object = object, A extends object = object> {
    readonly data: S;
    readonly sp: sp.State<S, A> | null;
    readonly active: Activation<S, A> | null;
    readonly nextActivationId: number;
    readonly sustain: sustain.Contributions<S, A> | null;
    readonly rules: readonly Rule<S, A>[];
    readonly spRecovered: readonly Hook<S, A, Events<S, A>["spRecovered"]>[];
    readonly spPaid: readonly Hook<S, A, Events<S, A>["spPaid"]>[];
    readonly spModified: readonly Hook<S, A, Events<S, A>["spModified"]>[];
    readonly ammoConsumed: readonly Hook<S, A, Events<S, A>["ammoConsumed"]>[];
    readonly ammoReplenished: readonly Hook<S, A, Events<S, A>["ammoReplenished"]>[];
    readonly activated: readonly Hook<S, A, Events<S, A>["activated"]>[];
    readonly ended: readonly Hook<S, A, Events<S, A>["ended"]>[];
}

export interface Skill<S extends object = object, A extends object = object> {
    readonly definition: { readonly skill: Definition<S, A> };
    readonly skill: State<S, A>;
}

export interface Stored {
    readonly definition: {
        readonly skill: {
            readonly id: string;
            readonly initialize: () => object;
            readonly sp: sp.Definition | null;
            readonly activation: {
                readonly trigger: ActivationDefinition<object, object>["trigger"];
                readonly sustain: sustain.Definition;
                readonly initialize: (battle: BattleState, self: never) => object;
            } | null;
        };
    };
    readonly skill: {
        readonly data: object;
        readonly sp: {
            readonly value: number;
            readonly lastTick: number;
            readonly recovery: {
                readonly periodTicks: number;
                readonly remainingTicks: number;
            } | null;
        } | null;
        readonly active: StoredActivation | null;
        readonly nextActivationId: number;
    };
}

export function hasSkill<U extends Unit>(unit: U): unit is U & Stored {
    return "skill" in unit && "skill" in unit.definition;
}

export function hasSkillDefinition(
    definition: UnitDefinition,
): definition is UnitDefinition & Stored["definition"] {
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

export function initialize<S extends object, A extends object>(
    battle: BattleState,
    definition: Definition<S, A>,
): Result<State<S, A>>;
export function initialize(
    battle: BattleState,
    definition: Stored["definition"]["skill"],
): Result<Stored["skill"]>;
export function initialize(
    battle: BattleState,
    definition: Stored["definition"]["skill"],
): Result<Stored["skill"]> {
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

function allowsInactiveRecovery<S extends object, A extends object>(
    _battle: BattleState,
    self: Unit & Skill<S, A>,
): boolean {
    return self.skill.active === null;
}

export function setData<S extends object, A extends object>(
    state: State<S, A>,
    next: NoInfer<S> | ((current: NoInfer<S>) => NoInfer<S>),
): State<S, A> {
    const data = typeof next === "function" ? next(state.data) : next;

    return data === state.data ? state : { ...state, data };
}

export function setRule<S extends object, A extends object>(
    state: State<S, A>,
    rule: Rule<S, A>,
): State<S, A> {
    const rules = registry.set(state.rules, rule);

    return rules === state.rules ? state : { ...state, rules };
}

export function removeRule<S extends object, A extends object>(
    state: State<S, A>,
    id: string,
): State<S, A> {
    const rules = registry.remove(state.rules, id);

    return rules === state.rules ? state : { ...state, rules };
}

export function setHook<S extends object, A extends object, K extends Key>(
    state: State<S, A>,
    key: K,
    hook: Hook<S, A, Events<S, A>[K]>,
): State<S, A> {
    const hooks = registry.set(state[key] as readonly Hook<S, A, Events<S, A>[K]>[], hook);

    return hooks === state[key] ? state : { ...state, [key]: hooks };
}

export function removeHook<S extends object, A extends object>(
    state: State<S, A>,
    key: Key,
    id: string,
): State<S, A> {
    const hooks = state[key].filter((hook) => hook.id !== id);

    return hooks.length === state[key].length ? state : { ...state, [key]: hooks };
}

export function setSpRecoveredHook<S extends object, A extends object>(
    state: State<S, A>,
    hook: Hook<S, A, Events<S, A>["spRecovered"]>,
): State<S, A> {
    return setHook(state, "spRecovered", hook);
}

export function removeSpRecoveredHook<S extends object, A extends object>(
    state: State<S, A>,
    id: string,
): State<S, A> {
    return removeHook(state, "spRecovered", id);
}

export function setSpPaidHook<S extends object, A extends object>(
    state: State<S, A>,
    hook: Hook<S, A, Events<S, A>["spPaid"]>,
): State<S, A> {
    return setHook(state, "spPaid", hook);
}

export function removeSpPaidHook<S extends object, A extends object>(
    state: State<S, A>,
    id: string,
): State<S, A> {
    return removeHook(state, "spPaid", id);
}

export function setSpModifiedHook<S extends object, A extends object>(
    state: State<S, A>,
    hook: Hook<S, A, Events<S, A>["spModified"]>,
): State<S, A> {
    return setHook(state, "spModified", hook);
}

export function removeSpModifiedHook<S extends object, A extends object>(
    state: State<S, A>,
    id: string,
): State<S, A> {
    return removeHook(state, "spModified", id);
}

export function setAmmoConsumedHook<S extends object, A extends object>(
    state: State<S, A>,
    hook: Hook<S, A, Events<S, A>["ammoConsumed"]>,
): State<S, A> {
    return setHook(state, "ammoConsumed", hook);
}

export function removeAmmoConsumedHook<S extends object, A extends object>(
    state: State<S, A>,
    id: string,
): State<S, A> {
    return removeHook(state, "ammoConsumed", id);
}

export function setAmmoReplenishedHook<S extends object, A extends object>(
    state: State<S, A>,
    hook: Hook<S, A, Events<S, A>["ammoReplenished"]>,
): State<S, A> {
    return setHook(state, "ammoReplenished", hook);
}

export function removeAmmoReplenishedHook<S extends object, A extends object>(
    state: State<S, A>,
    id: string,
): State<S, A> {
    return removeHook(state, "ammoReplenished", id);
}

export function setActivatedHook<S extends object, A extends object>(
    state: State<S, A>,
    hook: Hook<S, A, Events<S, A>["activated"]>,
): State<S, A> {
    return setHook(state, "activated", hook);
}

export function removeActivatedHook<S extends object, A extends object>(
    state: State<S, A>,
    id: string,
): State<S, A> {
    return removeHook(state, "activated", id);
}

export function setEndedHook<S extends object, A extends object>(
    state: State<S, A>,
    hook: Hook<S, A, Events<S, A>["ended"]>,
): State<S, A> {
    return setHook(state, "ended", hook);
}

export function removeEndedHook<S extends object, A extends object>(
    state: State<S, A>,
    id: string,
): State<S, A> {
    return removeHook(state, "ended", id);
}

export function setSustainContribution<S extends object, A extends object>(
    state: State<S, A>,
    entry: contribution.Contribution<Input<S, A>>,
): State<S, A> {
    const current = state.sustain;

    if (current === null || current.type === "INFINITE") {
        return state;
    }

    const updated =
        current.type === "TIME"
            ? { ...current, duration: contribution.set(current.duration, entry) }
            : { ...current, ammo: contribution.set(current.ammo, entry) };

    return { ...state, sustain: updated };
}

export function removeSustainContribution<S extends object, A extends object>(
    state: State<S, A>,
    id: string,
): State<S, A> {
    const current = state.sustain;

    if (current === null || current.type === "INFINITE") {
        return state;
    }

    const updated =
        current.type === "TIME"
            ? { ...current, duration: contribution.remove(current.duration, id) }
            : { ...current, ammo: contribution.remove(current.ammo, id) };

    return { ...state, sustain: updated };
}

export function validateState<S extends object, A extends object>(state: State<S, A>): void {
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
