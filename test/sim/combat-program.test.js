import assert from "node:assert/strict";
import { test } from "node:test";
import { battle, unit, actionDefinition, geometry } from "../helpers/action-fixture.js";
import { Definitions } from "../../dist/core/tactical/unit/action/definitions.js";
import * as actions from "../../dist/core/tactical/unit/action/operations.js";
import { advance } from "../../dist/core/tactical/unit/action/advance.js";
import { ref as unitRef } from "../../dist/core/tactical/unit/query.js";
import { getUnit, updateUnit, battlefieldView } from "../../dist/core/tactical/battle/state.js";
import { CombatResources } from "../../dist/core/tactical/battle/resources.js";
import { setHook } from "../../dist/core/tactical/unit/capability/vitality/damage/hook.js";
import { setHook as setHealingHook } from "../../dist/core/tactical/unit/capability/vitality/healing/hook.js";
import { setAttackContribution } from "../../dist/core/tactical/unit/capability/offense/capability.js";
import { create as modifier } from "../../dist/core/tactical/unit/contribution/value.js";
import { resolveAttackPower } from "../../dist/core/tactical/unit/capability/offense/query.js";
import { resolveDamage } from "../../dist/core/tactical/unit/capability/vitality/damage/settlement.js";
import { createDamageOperands } from "../../dist/core/tactical/unit/capability/vitality/damage/contract.js";
import { definition as createSkillDefinition } from "../helpers/skill.js";
import { activate } from "../../dist/core/tactical/unit/capability/skill/operations.js";

const targeting = {
    type: "DAMAGE",
    scope: { type: "RANGE", geometry: { type: "SHAPES", geometry } },
    canTargetAir: true,
    includeBlockingRelations: false,
    preferBlockingRelations: false,
    ignoreTargetFree: false,
    ignoreInvisible: false,
    maxTargets: 1,
};
const group = (operations) => ({ id: "primary", targeting, operations });
const start = (state, definition) => actions.start(state, unitRef(getUnit(state, 0)), definition);

test("ordinary attack: domain settlements observe each preceding returned battle state", () => {
    const resources = new CombatResources(),
        observed = [];
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
                    operation: { type: "HEAL", power: 5, ignoreHealFree: false },
                },
            ],
        },
        resources,
    );
    const source = unit(0, { action: definition }),
        target = unit(1);
    const initial = battle(
        {
            ...source,
            vitality: setHealingHook(source.vitality, {
                id: "observe-heal",
                stage: "reception",
                priority: 0,
                enabled: () => true,
                invoke(state, context, pending) {
                    observed.push({
                        request: context.request,
                        targetHp: getUnit(state, 1).vitality.hp,
                    });
                    return { state, value: { value: pending } };
                },
            }),
        },
        {
            ...target,
            vitality: setHook(target.vitality, {
                id: "observe-damage",
                stage: "reception",
                priority: 0,
                enabled: () => true,
                invoke(state, context, pending) {
                    observed.push({ request: context.request });
                    return { state, value: { value: pending } };
                },
            }),
        },
    );
    const result = start({ ...initial, tick: 7 }, definition);
    assert.equal(result.value.type, "STARTED");
    assert.equal(observed[0].request.operands.power, 10);
    assert.equal(observed[0].request.tick, 7);
    assert.equal(observed[1].request.targetUnitId, 0);
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
    const resources = new CombatResources();
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
        resources,
    );
    const target = unit(1);
    const initial = battle(unit(0, { hp: 10, action: definition }), {
        ...target,
        vitality: setHook(target.vitality, {
            id: "retaliation",
            stage: "reaction",
            priority: 0,
            enabled: (context) => context.request.targetUnitId === context.unit.id,
            invoke(state, context) {
                state = resolveDamage(state, {
                        sourceUnitId: 1,
                        targetUnitId: 0,
                        tick: context.tick,
                        damageType: "TRUE",
                        operands: createDamageOperands(10),
                    }, context.call).state;
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
    const cooldown = getUnit(result.state, 0).action.cooldowns.get(definition.id);
    assert.ok(cooldown === undefined || cooldown.readyAtTick <= initial.tick);
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
    const resources = new CombatResources();
    const definition = {
        id: "non-attack",
        intervalTicks: 10,
        speed: 100,
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
            id: "cancel-release", enabled: () => true,
            invoke(state) {
                return actions.cancel(state, actions.all(state)[0], "CANCELLED");
            },
        }],
    } };
    const original = battle(configured, unit(1));
    const result = start(original, attack);
    assert.equal(getUnit(result.state, 0).skill.sp.value, 1);
    assert.equal(getUnit(result.state, 1).vitality.hp, 100);
    assert.equal(result.state.actions.size, 0);
    assert.equal(result.state.events.filter(event => event.type === "ACTION_RELEASED").length, 1);
    assert.equal(getUnit(original, 0).skill.sp.value, 0);
});
