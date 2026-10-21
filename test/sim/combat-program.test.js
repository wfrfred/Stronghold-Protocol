import { damage as damageTargeting } from "../helpers/targeting.js";
import { damage as dealDamage, parameters } from "../helpers/vitality.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { battle, unit, actionDefinition, geometry } from "../helpers/action-fixture.js";
import { Definitions } from "../../dist/core/tactical/unit/action/definitions.js";
import { createWithState } from "../../dist/content/tactical/actions/attack.js";
import * as actions from "../../dist/core/tactical/unit/action/operations.js";
import { advance } from "../../dist/core/tactical/unit/action/advance.js";
import { ref as unitRef } from "../../dist/core/tactical/unit/query.js";
import { getUnit, updateUnit, battlefieldView } from "../../dist/core/tactical/battle/state.js";

import { setHook } from "../../dist/core/tactical/battle/damage/hook.js";
import { setHook as setHealingHook } from "../../dist/core/tactical/battle/healing/hook.js";
import { setAttackContribution } from "../../dist/core/tactical/unit/capability/offense/capability.js";
import { create as modifier } from "../../dist/core/tactical/unit/contribution/attribute.js";
import { resolveAttackPower } from "../../dist/core/tactical/unit/capability/offense/query.js";
import { definition as createSkillDefinition } from "../helpers/skill.js";
import { activate, enter as enterSkill } from "../../dist/core/tactical/unit/capability/skill/operations.js";

const targeting = damageTargeting({ geometry: { type: "SHAPES", geometry }, canTargetAir: true });
const group = (operations) => ({ id: "primary", targeting, operations });
const start = (state, definition) => actions.start(state, unitRef(getUnit(state, 0)), definition);

test("ordinary attack: phase correction samples the cooldown returned by its startup callback", () => {
    const definition = createWithState({
        ...actionDefinition().attack,
        initialize: state => ({ state, value: {} }),
        start(state, source, self) {
            return { state: actions.clearCooldown(state, source, self.definition.id), value: {} };
        },
    });
    let initial = { ...battle(unit(0, { action: definition }), unit(1)), tick: 10 };
    const source = unitRef(getUnit(initial, 0));
    const current = actions.getState(initial, source, definition);
    initial = actions.replaceState(initial, source, {
        ...current, cooldown: { ...current.cooldown, readyAtTick: 9.75 },
    });
    const started = start(initial, definition);
    assert.equal(started.value.type, "STARTED");
    assert.equal(actions.getState(started.state, source, definition).cooldown.readyAtTick, 20);
    assert.equal(actions.getState(initial, source, definition).cooldown.readyAtTick, 9.75);
    assert.equal(getUnit(started.state, 1).vitality.hp, 93);
});

test("ordinary attack: domain settlements observe each preceding returned battle state", () => {
    const observed = [];
    const definition = actionDefinition(
        1,
        {
            targetGroups: [
                group([
                    {
                        type: "DAMAGE",
                        powerSource: "SOURCE_ATTACK",
                        power: 1,
                        damageType: "PHYSICAL",
                    },
                ]),
            ],
            followUps: [
                {
                    receiver: { type: "SOURCE" },
                    operation: { type: "HEAL", power: 5 },
                },
            ],
        },
    );
    const source = unit(0, { action: definition }),
        target = unit(1);
    const initial = battle(
        {
            ...source,
            vitality: setHealingHook(source.vitality, {
                id: "observe-heal",
                stage: "receiving",
                priority: 0,
                accepts: () => true,
                invoke(state, context, pending) {
                    observed.push({
                        request: context.request,
                        targetHp: getUnit(state, 1).vitality.hp,
                    });
                    return { state, value: pending };
                },
            }),
        },
        {
            ...target,
            vitality: setHook(target.vitality, {
                id: "observe-damage",
                stage: "receiving",
                priority: 0,
                accepts: () => true,
                invoke(state, context, pending) {
                    observed.push({ request: context.request, tick: state.tick });
                    return { state, value: pending };
                },
            }),
        },
    );
    const result = start({ ...initial, tick: 7 }, definition);
    assert.equal(result.value.type, "STARTED");
    assert.equal(observed[0].request.parameters.attack.power, 10);
    assert.equal(observed[0].tick, 7);
    assert.equal(observed[1].request.target.id, 0);
    assert.equal(observed[1].targetHp, 90);
    assert.equal(getUnit(result.state, 1).vitality.hp, 90);
    assert.equal(getUnit(initial, 1).vitality.hp, 100);
});

test("ordinary attack: a subsequent action selects a current target after the previous target departs", () => {
    const definition = actionDefinition(7),
        initial = battle(unit(0, { action: definition }), unit(1, { hp: 7 }), unit(2));
    const first = start(initial, definition);
    assert.equal(getUnit(first.state, 1), undefined);
    assert.equal(getUnit(first.state, 2).vitality.hp, 100);
    const second = start({ ...first.state, tick: 10 }, definition);
    assert.equal(second.value.type, "STARTED");
    assert.equal(getUnit(second.state, 2).vitality.hp, 93);
});

test("ordinary attack: live source attack reads current contributions and fixed power retains its own value", () => {
    const live = actionDefinition(1, {
        id: "live",
        targetGroups: [
            group([{ type: "DAMAGE", powerSource: "SOURCE_ATTACK", power: 1, damageType: "TRUE" }]),
        ],
    });
    const fixed = actionDefinition(5, { id: "fixed" });
    const source = unit(0, { action: { definitions: Definitions.empty().add(live).add(fixed) } });
    const initial = battle(source, unit(1));
    const boosted = updateUnit(initial, {
        ...source,
        offense: setAttackContribution(source.offense, {
            id: "bonus",
            value: [modifier({ addition: 15 })],
        }),
    });
    const first = start(boosted, live),
        second = start(first.state, fixed);
    assert.equal(getUnit(first.state, 1).vitality.hp, 75);
    assert.equal(getUnit(second.state, 1).vitality.hp, 70);
    assert.equal(getUnit(initial, 1).vitality.hp, 100);
});

test("ordinary attack: lethal retaliation invalidates a later unsampled source attack", () => {

    const definition = actionDefinition(
        1,
        {
            targetGroups: [
                group([
                    { type: "DAMAGE", powerSource: "SOURCE_ATTACK", power: 1, damageType: "TRUE" },
                    { type: "DAMAGE", powerSource: "SOURCE_ATTACK", power: 1, damageType: "TRUE" },
                ]),
            ],
        },
    );
    const target = unit(1);
    const initial = battle(unit(0, { hp: 10, action: definition }), {
        ...target,
        vitality: setHook(target.vitality, {
            id: "retaliation",
            stage: "hpApplied",
            priority: 0,
            accepts: (_battle, context) => context.request.target.id === target.id,
            invoke(state, context) {
                state = dealDamage(state, { source: { id: 1 }, target: { id: 0 }, parameters: parameters(10, "TRUE") }).state;
                return { state, value: undefined };
            },
        }),
    });
    const result = start(initial, definition);
    assert.equal(getUnit(result.state, 0), undefined);
    assert.equal(getUnit(result.state, 1).vitality.hp, 90);
    assert.equal(actions.get(result.state, result.value.ref), undefined);
});

test("ordinary attack: no target rejects startup without an instance or a consumed cooldown", () => {
    const definition = actionDefinition(),
        initial = battle(unit(0, { action: definition }));
    const result = start(initial, definition);
    assert.deepEqual(result.value, { type: "REJECTED", reason: "CONDITION" });
    assert.equal(result.state, initial);
    assert.equal(actions.all(result.state).length, 0);
    const cooldown = getUnit(result.state, 0).action.states.get(definition.id).cooldown;
    assert.ok(cooldown.readyAtTick <= initial.tick);
});

test("ordinary attack: a configured definition is shared while accepted progress belongs to its instance", () => {
    const definition = actionDefinition(7, { windupTicks: 2 });
    const initial = battle(unit(0, { action: definition }), unit(1));
    const started = start(initial, definition),
        self = actions.get(started.state, started.value.ref);
    assert.equal(self.definition, definition);
    assert.equal(self.state.released, false);
    const released = advance({ ...started.state, tick: 2 }, started.value.ref);
    assert.equal(getUnit(released, 1).vitality.hp, 93);
    assert.equal(self.state.released, false);
    assert.equal(getUnit(started.state, 1).vitality.hp, 100);
});

test("action: a leaving source cannot start and an unrelated definition is a contract error", () => {
    const definition = actionDefinition(),
        source = unit(0, { action: definition });
    const initial = battle({ ...source, lifecycle: "LEAVING" }, unit(1));
    assert.deepEqual(start(initial, definition).value, {
        type: "REJECTED",
        reason: "SOURCE_UNAVAILABLE",
    });
    const ready = battle(source, unit(1));
    assert.throws(() => start(ready, actionDefinition(7, { id: "unconfigured" })));
});

test("action: generic non-attack programs do not earn attack SP or consume skill ammunition", () => {

    const definition = {
        id: "non-attack",
        intervalTicks: 10,
        speed: 100,
        initialize: state => ({ state, value: {} }),
        start: (state) => ({ state, value: {} }),
        step: (state) => ({ state, value: true }),
    };
    const skill = createSkillDefinition({
        id: "unrelated-skill",
        sp: { initial: 0, capacity: 0, requirement: 0, recovery: { type: "ACTION", amount: 1 } },
        activation: { trigger: "MANUAL", sustain: { type: "AMMO", amount: 3 }, initialize: () => ({}) },
    });
    let state = battle(unit(0, { action: definition, skill }), unit(1));
    state = activate(state, unitRef(getUnit(state, 0))).state;
    const result = start(state, definition);
    assert.equal(getUnit(result.state, 0).skill.active.sustain.remaining, 3);
    assert.equal(getUnit(result.state, 0).skill.sp.value, 0);
    assert.equal(resolveAttackPower(0, battlefieldView(result.state)), 10);
});

test("ACTION recovery callbacks may cancel the releasing attack before its output", () => {
    const attack = actionDefinition(20);
    const skill = createSkillDefinition({
        sp: { initial: 0, capacity: 1, requirement: 1, recovery: { type: "ACTION", amount: 1 } },
    });
    const source = unit(0, { action: attack, skill });
    const configured = { ...source, skill: {
        ...source.skill,
        spRecovered: [{
            id: "cancel-release",
            invoke(state) {
                return { state: actions.cancel(state, actions.all(state)[0], "CANCELLED"), value: undefined };
            },
        }],
    } };
    const original = enterSkill(battle(configured, unit(1)), unitRef(configured));
    const result = start(original, attack);
    assert.equal(getUnit(result.state, 0).skill.sp.value, 1);
    assert.equal(getUnit(result.state, 1).vitality.hp, 100);
    assert.equal(getUnit(result.state, 0).action.instances.size, 0);
    assert.equal(result.state.events.filter(event => event.type === "ACTION_RELEASED").length, 1);
    assert.equal(getUnit(original, 0).skill.sp.value, 0);
});
