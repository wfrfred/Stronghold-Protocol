import { resolveDamage } from "../../dist/core/tactical/unit/capability/vitality/damage/settlement.js";
import { ref as unitRef } from "../../dist/core/tactical/unit/query.js";
import { setData } from "../../dist/core/tactical/unit/effect/effect.js";
import { fixtureBattlefieldState as fixtureBattlefield } from "../helpers/battlefield.js";
import { Definitions } from "../../dist/core/tactical/unit/action/definitions.js";
import * as actions from "../../dist/core/tactical/unit/action/operations.js";
import { create as createBattlefield } from "../../dist/core/tactical/battlefield/state.js";
import { createBattlefieldMap } from "../../dist/core/tactical/battlefield/map/map.js";
import { createNavigationModifierDefinition } from "../../dist/core/tactical/battlefield/navigation/modifier.js";
import { createDefinition as createDeployableDefinition } from "../../dist/core/tactical/unit/capability/deployable/capability.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { addCard } from "../../dist/core/tactical/battle/deployment/deployment.js";
import { resolveDeploymentCommands } from "../../dist/core/tactical/battle/deployment/operations.js";
import {
    advancePredefined,
    createPredefinedDefinition,
} from "../../dist/core/tactical/battle/steps/predefined.js";
import {
    createBattleState,
    battlefieldView,
    getUnit,
    transitionUnit,
} from "../../dist/core/tactical/battle/state.js";
import { initialize } from "../helpers/unit.js";
import { createDefinition as createSkillDefinition } from "../../dist/core/tactical/unit/capability/skill/capability.js";
import { activate } from "../../dist/core/tactical/unit/capability/skill/operations.js";
import { ref as activationRef } from "../../dist/core/tactical/unit/capability/skill/activation.js";
import * as effects from "../../dist/core/tactical/unit/effect/operations.js";
import { get } from "../../dist/core/tactical/unit/effect/operations.js";
import { definition } from "../helpers/effects.js";
import {
    setHook,
    removeHook,
} from "../../dist/core/tactical/unit/capability/vitality/damage/hook.js";
import { createDamageOperands } from "../../dist/core/tactical/unit/capability/vitality/damage/contract.js";

function fixture() {
    const skill = createSkillDefinition({
        id: "departing-counter-skill",
        initialize: () => ({}),
        sp: null,
        activation: {
            trigger: "MANUAL",
            sustain: { type: "INFINITE" },
            initialize: () => ({}),
            onEnd: state => resolveDamage(state, {
                sourceUnitId: null,
                targetUnitId: 2,
                damageType: "TRUE",
                operands: createDamageOperands(1),
                tick: state.tick,
            }).state,
        },
    });
    const counter = definition(
        "consume-on-damage",
        { consumed: 0 },
        {
            onInstall(state, ctx) {
                const ref = ctx.ref;
                return transitionUnit(state, ref.host.id, (unit) =>
                    ({ ...unit, vitality: setHook(unit.vitality, {
                        id: "consume",
                        stage: "reception",
                        priority: 0,
                        enabled: context => context.unit.effects.values().find(effect => effect.id === ref.id)?.status === "ACTIVE",
                        invoke(state, context, value) {
                            const current = get(state, ref);
                            state = effects.replaceEffect(state, ref, setData(current, { consumed: current.data.consumed + 1 }));
                            return { state, value: { value } };
                        },
                    }) }),
                );
            },
            onEnd(state, ctx) {
                return transitionUnit(state, ctx.ref.host.id, (unit) => ({ ...unit, vitality: removeHook(unit.vitality, "consume") }));
            },
        },
    );
    const units = Array.from({ length: 3 }, (_, id) =>
        initialize({
            id,
            position: [id, 0],
            definition: {
                id: `departure-${id}`,
                vitality: { maxHp: 100 },
                ...(id < 2 ? { skill } : {}),
            },
        }),
    );
    const byId = new Map(units.map((unit) => [unit.id, unit]));
    const battlefield = {
        unitIds: [0, 1, 2],
        getUnit: (id) => byId.get(id),
        blockerOf: () => undefined,
        blockedBy: () => [],
        supportRelations: [],
    };
    let work = createBattleState(fixtureBattlefield(battlefield), undefined);
    for (const id of [0, 1]) work = activate(work, unitRef(getUnit(work, id))).state;
    work = effects.install(work, unitRef(getUnit(work, 2)), counter).state;
    return { battlefield: work.battlefield, execution: work.execution };
}

for (const domain of ["deployment", "predefined"]) {
    test(`${domain}: successive departures share effect updates from skill finish damage`, () => {
        const { battlefield, execution } = fixture();
        const before = battlefieldView(createBattleState(battlefield));
        let state = createBattleState(battlefield, execution, undefined, 1);
        if (domain === "deployment") {
            state = resolveDeploymentCommands(
                state,
                [
                    { type: "RETREAT_UNIT", unitId: 0 },
                    { type: "RETREAT_UNIT", unitId: 1 },
                ],
            );
        } else {
            state = advancePredefined(
                { ...state, predefinedPresence: [
                    { definitionId: 10, source: { type: "UNIT", unitId: 0 } },
                    { definitionId: 11, source: { type: "UNIT", unitId: 1 } },
                ] },
                [{ id: 10 }, { id: 11 }],
                [
                    { type: "REMOVE_PREDEFINED", definitionId: 10, reason: "SCRIPT" },
                    { type: "REMOVE_PREDEFINED", definitionId: 11, reason: "SCRIPT" },
                ],
                1,
            );
        }

        assert.equal(getUnit(state, 2).effects.values()[0].data.consumed, 2);
        assert.equal(before.getUnit(2).effects.values()[0].data.consumed, 0);
        assert.deepEqual(
            state.removedUnits.map((unit) => unit.unitId),
            [0, 1],
        );
        assert.equal(state.events.filter((event) => event.type === "SKILL_FINISHED").length, 2);
        assert.equal(getUnit(state, 2).vitality.hp, 98);
    });
}

for (const domain of ["deployment", "predefined"]) {
    test(`${domain}: creation then departure preserves removal facts and cleans attached navigation modifiers`, () => {
        const map = createBattlefieldMap(
            1,
            2,
            Array.from({ length: 2 }, () => ({
                heightType: "LOWLAND",
                buildableType: "ALL",
                passableMask: "ALL",
                playerSideMask: "ALL",
                terrain: "NORMAL",
                mechanism: null,
            })),
        );
        const battlefield = createBattlefield({ map });
            const definition = Object.freeze({
            id: "transient-placement", occupancy: {},
            deployable: createDeployableDefinition({ cost: 0, redeployTicks: 0, slots: 1, buildableType: "ALL" }),
            vitality: Object.freeze({ maxHp: 100 }),
        });
        const navigationModifiers = [
            {
                definition: createNavigationModifierDefinition({
                    id: "transient-wall",
                    FLY: null,
                    WALK: { denyPassage: false, deniedDepartures: [], costFloor: 10 },
                }),
                range: [[0, 0]],
                direction: "RIGHT",
            },
        ];
        let state = createBattleState(battlefield);
        if (domain === "deployment") {
            state = addCard(state, { unit: definition, navigationModifiers }).state;
            state = addCard(state, { unit: definition }).state;
            state = resolveDeploymentCommands(
                state,
                [
                    {
                        type: "DEPLOY_UNIT",
                        cardId: 0,
                        tilePosition: [0, 0],
                        playerSide: "SIDE_A",
                    },
                    { type: "RETREAT_UNIT", unitId: 0 },
                    { type: "DEPLOY_UNIT", cardId: 1, tilePosition: [0, 0], playerSide: "SIDE_A" },
                ],
            );
        } else {
            state = advancePredefined(
                state,
                [
                    createPredefinedDefinition({
                        id: 10,
                        alias: null,
                        initiallyPresent: false,
                        creation: {
                            type: "UNIT",
                            definition,
                            position: [0, 0],
                            navigationModifiers,
                        },
                    }),
                ],
                [
                    { type: "APPEAR_PREDEFINED", definitionId: 10 },
                    { type: "REMOVE_PREDEFINED", definitionId: 10, reason: "SCRIPT" },
                ],
                0,
            );
        }

        assert.deepEqual(
            state.removedUnits.map((unit) => unit.unitId),
            [0],
        );
        assert.deepEqual(battlefieldView(state).navigationModifierIds, []);
        assert.deepEqual(battlefieldView(state).unitIds, domain === "deployment" ? [1] : []);
    });
}

test("effect terminal callback can retire its host and settle remote Action and Skill dependencies immediately", () => {
    const trace = [];
    const skill = createSkillDefinition({
        id: "nested-skill",
        initialize: () => ({}),
        sp: null,
        activation: {
            trigger: "MANUAL",
            sustain: { type: "INFINITE" },
            initialize: () => ({}),
            onEnd: state => {
                trace.push("skill");
                return state;
            },
        },
    });
    const action = {
        id: "owned-action", intervalTicks: 1, speed: 100,
        start: state => ({ state, value: {} }),
        step: state => ({ state, value: false }),
    };
    const units = [
        initialize({
            id: 0,
            position: [0, 0],
            definition: { id: "source", vitality: { maxHp: 100 }, skill, action: { definitions: Definitions.empty().add(action) } },
        }),
        initialize({
            id: 1,
            position: [1, 0],
            definition: { id: "receiver", vitality: { maxHp: 100 } },
        }),
    ];
    let battle = createBattleState(fixtureBattlefield(units));
    battle = activate(battle, unitRef(getUnit(battle, 0))).state;
    const started = actions.start(battle, unitRef(getUnit(battle, 0)), action);
    battle = started.state;
    assert.equal(started.value.type, "STARTED");
    const actionDependent = definition(
        "action-dependent",
        {},
        {
            onEnd: (state, context) => {
                assert.equal(context.reason, "DEATH");
                trace.push("action-effect");
                return state;
            },
        },
    );
    const skillDependent = definition(
        "skill-dependent",
        {},
        {
            onEnd: state => {
                trace.push("skill-effect");
                return state;
            },
        },
    );
    battle = effects.install(battle, unitRef(getUnit(battle, 1)), actionDependent, {
        scopes: [{ type: "ACTION", ref: started.value.ref }],
    }).state;
    battle = effects.install(battle, unitRef(getUnit(battle, 1)), skillDependent, {
        scopes: [{ type: "SKILL", ref: activationRef(getUnit(battle, 0).skill.active) }],
    }).state;
    const content = definition(
        "nested-death",
        {},
        {
            onEnd(state, ctx) {
                trace.push("effect");
                state = resolveDamage({ ...state, tick: 1 }, {
                    sourceUnitId: null,
                    targetUnitId: 0,
                    damageType: "TRUE",
                    operands: createDamageOperands(100),
                    tick: 1,
                }, ctx.call).state;
                trace.push("after-damage");
                assert.equal(getUnit(state, 0), undefined);
                assert.equal(actions.get(state, started.value.ref), undefined);
                return state;
            },
        },
    );
    const installed = effects.install(battle, unitRef(getUnit(battle, 0)), content);
    battle = effects.end(installed.state, installed.value);
    assert.equal(getUnit(battle, 0), undefined);
    assert.deepEqual(getUnit(battle, 1).effects.values(), []);
    assert.ok(trace.indexOf("action-effect") < trace.indexOf("after-damage"));
    assert.ok(trace.indexOf("skill-effect") < trace.indexOf("after-damage"));
    assert.ok(trace.indexOf("skill") < trace.indexOf("after-damage"));
    assert.equal(battle.events.filter((event) => event.type === "ACTION_CANCELLED").length, 1);
    assert.equal(battle.events.filter((event) => event.type === "SKILL_FINISHED").length, 1);
});
