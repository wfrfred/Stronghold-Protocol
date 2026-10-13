import assert from "node:assert/strict";
import { test } from "node:test";
import * as offense from "../../dist/core/tactical/unit/capability/offense/capability.js";
import * as defense from "../../dist/core/tactical/unit/capability/defense/capability.js";
import * as blocker from "../../dist/core/tactical/unit/capability/blocking/blocker.js";
import * as locomotion from "../../dist/core/tactical/unit/capability/locomotion/capability.js";
import * as action from "../../dist/core/tactical/unit/capability/action/capability.js";
import * as vitality from "../../dist/core/tactical/unit/capability/vitality/capability.js";
import * as damage from "../../dist/core/tactical/unit/capability/vitality/damage/hook.js";
import * as healing from "../../dist/core/tactical/unit/capability/vitality/healing/hook.js";
import { create } from "../../dist/core/tactical/unit/contribution/value.js";

const entries = [
    [
        offense.initialize(),
        "attack",
        offense.setAttackContribution,
        offense.removeAttackContribution,
    ],
    [
        defense.initialize(),
        "defense",
        defense.setDefenseContribution,
        defense.removeDefenseContribution,
    ],
    [
        defense.initialize(),
        "resistance",
        defense.setResistanceContribution,
        defense.removeResistanceContribution,
    ],
    [
        blocker.initialize({ capacity: 2, geometry: { radius: 0.5 } }),
        "capacity",
        blocker.setCapacityContribution,
        blocker.removeCapacityContribution,
    ],
    [
        locomotion.initialize(),
        "moveSpeed",
        locomotion.setMoveSpeedContribution,
        locomotion.removeMoveSpeedContribution,
    ],
    [
        action.initialize(5),
        "attackSpeed",
        action.setAttackSpeedContribution,
        action.removeAttackSpeedContribution,
    ],
    [
        action.initialize(5),
        "baseAttackTime",
        action.setBaseAttackTimeContribution,
        action.removeBaseAttackTimeContribution,
    ],
];

test("local contribution updates share untouched state and leave earlier versions stable", () => {
    const entry = { id: "bonus", value: [create({ addition: 10 })] };
    for (const [initial, field, set, remove] of entries) {
        const added = set(initial, entry);
        assert.equal(initial[field].length, 0, field);
        assert.equal(added[field][0], entry, field);
        assert.equal(set(added, entry), added, field);
        assert.equal(remove(added, "missing"), added, field);
        for (const key of Object.keys(initial).filter((key) => key !== field)) {
            assert.equal(added[key], initial[key], `${field}: ${key}`);
        }
        const removed = remove(added, entry.id);
        assert.equal(removed[field].length, 0, field);
        assert.equal(added[field][0], entry, field);
    }
});

test("local hook registration retains progress and changes only its registration collection", () => {
    const hook = {
        id: "hook",
        stage: "reception",
        priority: 0,
        enabled: () => true,
        invoke: (state, _context, value) => ({ state, value }),
    };
    const registrations = [
        [
            vitality.initialize({ maxHp: 100 }),
            "damageHooks",
            damage.setHook,
            damage.removeHook,
        ],
        [
            vitality.initialize({ maxHp: 100 }),
            "healingHooks",
            healing.setHook,
            healing.removeHook,
        ],
        [
            action.initialize(5),
            "beforeRelease",
            action.setBeforeReleaseHook,
            action.removeBeforeReleaseHook,
        ],
    ];
    for (const [initial, field, set, remove] of registrations) {
        const added = set(initial, hook);
        assert.equal(added[field][0], hook, field);
        assert.equal(initial[field].length, 0, field);
        assert.equal(set(added, hook), added, field);
        assert.equal(remove(added, "missing"), added, field);
        for (const key of Object.keys(initial).filter((key) => key !== field)) {
            assert.equal(added[key], initial[key], `${field}: ${key}`);
        }
        assert.equal(remove(added, hook.id)[field].length, 0, field);
        assert.equal(added[field][0], hook, field);
    }
});
