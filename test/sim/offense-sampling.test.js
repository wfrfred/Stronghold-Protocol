import assert from "node:assert/strict";
import { test } from "node:test";
import { battle, unit, actionDefinition, geometry } from "../helpers/action-fixture.js";
import { damage } from "../helpers/targeting.js";
import * as units from "../../dist/core/tactical/unit/query.js";
import * as actions from "../../dist/core/tactical/unit/action/operations.js";
import { updateUnit } from "../../dist/core/tactical/battle/state.js";
import { setHook } from "../../dist/core/tactical/battle/damage/hook.js";
import { setAttackContribution } from "../../dist/core/tactical/unit/capability/offense/capability.js";
import { create as modifier } from "../../dist/core/tactical/unit/contribution/attribute.js";

test("source attack samples current Offense separately for each target after nested reactions", () => {
    const definition = actionDefinition(1, {
        targetGroups: [{
            id: "primary",
            targeting: damage({ geometry, canTargetAir: true, maxTargets: 2 }),
            operations: [{ type: "DAMAGE", powerSource: "SOURCE_ATTACK", power: 1, damageType: "TRUE" }],
        }],
    });
    const source = unit(0, { action: definition });
    const sourceRef = units.ref(source);
    const first = unit(1);
    const second = unit(2);
    const initial = battle(source, {
        ...first,
        vitality: setHook(first.vitality, {
            id: "boost-next-target", stage: "hpApplied", priority: 0,
            invoke(state) {
                const current = units.get(state, sourceRef);
                return {
                    state: updateUnit(state, {
                        ...current,
                        offense: setAttackContribution(current.offense, {
                            id: "reaction", value: [modifier({ addition: 15 })],
                        }),
                    }),
                    value: undefined,
                };
            },
        }),
    }, second);
    const result = actions.start(initial, sourceRef, definition);
    assert.equal(result.value.type, "STARTED");
    assert.equal(units.get(result.state, units.ref(first)).vitality.hp, 90);
    assert.equal(units.get(result.state, units.ref(second)).vitality.hp, 75);
    assert.equal(units.get(initial, sourceRef).offense.attack.length, 0);
});

test("fixed damage and healing do not require an Offense capability", () => {
    const definition = actionDefinition(5, {
        followUps: [{ receiver: { type: "SOURCE" }, operation: { type: "HEAL", power: 5 } }],
    });
    const source = unit(0, { action: definition, offense: undefined });
    const target = unit(1);
    const sourceRef = units.ref(source);
    const initial = battle({ ...source, vitality: { ...source.vitality, hp: 50 } }, target);
    const result = actions.start(initial, sourceRef, definition);
    assert.equal(result.value.type, "STARTED");
    assert.equal(units.get(result.state, sourceRef).vitality.hp, 55);
    assert.equal(units.get(result.state, units.ref(target)).vitality.hp, 95);
});
