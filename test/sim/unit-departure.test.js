import { fixtureBattlefieldState as fixtureBattlefield } from "../helpers/battlefield.js";
import { createActionDefinition } from "../../dist/core/tactical/unit/capability/action/capability.js";
import {
    acceptActionExecution,
    createActionExecutionState,
} from "../../dist/core/tactical/unit/capability/action/process.js";
import { getActionExecution } from "../../dist/core/tactical/unit/capability/action/internal/executions.js";
import { create as createBattlefield } from "../../dist/core/tactical/battlefield/state.js";
import { createBattlefieldMap } from "../../dist/core/tactical/battlefield/map/map.js";
import { createNavigationModifierDefinition } from "../../dist/core/tactical/battlefield/navigation/modifier.js";
import { createDeploymentProfile } from "../../dist/core/tactical/unit/capability/deployment.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { CombatResources } from "../../dist/core/tactical/battle/resources.js";
import { resolveDeploymentCommands } from "../../dist/core/tactical/battle/steps/deployment.js";
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
import { initializeUnit } from "../../dist/core/tactical/unit/initialize.js";
import { createSkillDefinition } from "../../dist/core/tactical/unit/capability/skill/capability.js";
import { activateSkill } from "../../dist/core/tactical/unit/capability/skill/execution.js";
import * as effects from "../../dist/core/tactical/unit/effect/operations.js";
import { get } from "../../dist/core/tactical/unit/effect/query.js";
import { definition } from "../helpers/effects.js";
import {
    setHook,
    removeHook,
} from "../../dist/core/tactical/unit/capability/vitality/damage/hook.js";

import { createDamageOperands } from "../../dist/core/tactical/unit/capability/vitality/damage/contract.js";

function fixture() {
    const resources = new CombatResources();
    const skill = createSkillDefinition({
        id: "departing-counter-skill",
        activation: "MANUAL",
        spRecovery: "NONE",
        spCost: 0,
        initialSp: 0,
        durationTicks: null,
    });
    resources.skills.register({
        definition: skill,
        activate: state => ({ state, value: { type: "ACTIVATED" } }),
        finish: (state, context) => {
            return resources.settleDamage(state, {
                sourceUnitId: null,
                targetUnitId: 2,
                damageType: "TRUE",
                operands: createDamageOperands(1),
                tick: context.tick,
            }, context.call).state;
        },
    });
    const counter = definition(
        "consume-on-damage",
        { consumed: 0 },
        {
            onInstall(state, ctx) {
                const ref = ctx.ref;
                return transitionUnit(state, ref.unitId, (unit) =>
                    setHook(unit, {
                        id: "consume",
                        stage: "reception",
                        priority: 0,
                        enabled: context => context.unit.effects.instances.find(effect => effect.id === ref.effectId)?.status === "ACTIVE",
                        invoke(state, context, value) {
                            const current = get(state, ref);
                            state = effects.replaceEffect(state, ref.unitId, effects.setState(current, { consumed: current.state.consumed + 1 }));
                            return { state, value: { value } };
                        },
                    }),
                );
            },
            onEnd(state, ctx) {
                return transitionUnit(state, ctx.ref.unitId, (unit) => removeHook(unit, "consume"));
            },
        },
    );
    const units = Array.from({ length: 3 }, (_, id) =>
        initializeUnit({
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
    for (const id of [0, 1]) work = activateSkill(work, { unitId: id, tick: 0 }, resources).state;
    work = effects.install(work, getUnit(work, 2), counter).state;
    return { battlefield: work.battlefield, resources, execution: work.execution };
}

for (const domain of ["deployment", "predefined"]) {
    test(`${domain}: successive departures share effect updates from skill finish damage`, () => {
        const { battlefield, resources, execution } = fixture();
        const before = battlefieldView(createBattleState(battlefield));
        let state = createBattleState(battlefield, execution, undefined, 1);
        if (domain === "deployment") {
            state = resolveDeploymentCommands(
                state,
                [
                    { type: "RETREAT_UNIT", unitId: 0 },
                    { type: "RETREAT_UNIT", unitId: 1 },
                ],
                1,
                resources,
            );
        } else {
            state = advancePredefined(
                state,
                [{ id: 10 }, { id: 11 }],
                [
                    { definitionId: 10, source: { type: "UNIT", unitId: 0 } },
                    { definitionId: 11, source: { type: "UNIT", unitId: 1 } },
                ],
                [
                    { type: "REMOVE_PREDEFINED", definitionId: 10, reason: "SCRIPT" },
                    { type: "REMOVE_PREDEFINED", definitionId: 11, reason: "SCRIPT" },
                ],
                1,
                resources,
            ).state;
        }

        assert.equal(getUnit(state, 2).effects.instances[0].state.consumed, 2);
        assert.equal(before.getUnit(2).effects.instances[0].state.consumed, 0);
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
        const resources = new CombatResources();
        const definition = Object.freeze({
            id: "transient-placement",
            deployment: createDeploymentProfile({ buildableType: "ALL" }),
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
            state = resolveDeploymentCommands(
                state,
                [
                    {
                        type: "DEPLOY_UNIT",
                        definition,
                        navigationModifiers,
                        tilePosition: [0, 0],
                        playerSide: "SIDE_A",
                    },
                    { type: "RETREAT_UNIT", unitId: 0 },
                    { type: "DEPLOY_UNIT", definition, tilePosition: [0, 0], playerSide: "SIDE_A" },
                ],
                0,
                resources,
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
                [],
                [
                    { type: "APPEAR_PREDEFINED", definitionId: 10 },
                    { type: "REMOVE_PREDEFINED", definitionId: 10, reason: "SCRIPT" },
                ],
                0,
                resources,
            ).state;
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
    const resources = new CombatResources();
    const trace = [];
    const skill = createSkillDefinition({
        id: "nested-skill",
        activation: "MANUAL",
        spRecovery: "NONE",
        spCost: 0,
        initialSp: 0,
        durationTicks: null,
    });
    resources.skills.register({
        definition: skill,
        activate: state => ({ state, value: { type: "ACTIVATED" } }),
        finish: state => {
            trace.push("skill");
            return state;
        },
    });
    const action = createActionDefinition({
        triggerBindingId: "primary",
        baseAttackTimeTicks: 1,
        recoveryTicks: 0,
        targetGroups: [
            {
                id: "primary",
                targeting: {
                    type: "DAMAGE",
                    scope: { type: "BLOCKER" },
                    canTargetAir: true,
                    includeBlockingRelations: false,
                    preferBlockingRelations: false,
                    ignoreTargetFree: false,
                    ignoreInvisible: false,
                    maxTargets: 1,
                },
                operations: [{ type: "DAMAGE", power: 1, damageType: "TRUE" }],
            },
        ],
        followUps: [],
    });
    const accepted = acceptActionExecution(createActionExecutionState(), {
        sourceUnitId: 0,
        definition: action,
        inputTargetUnitId: 1,
        bindings: new Map([["primary", [1]]]),
        tick: 0,
    });
    const executions = accepted.state;
    const units = [
        initializeUnit({
            id: 0,
            position: [0, 0],
            definition: { id: "source", vitality: { maxHp: 100 }, skill },
        }),
        initializeUnit({
            id: 1,
            position: [1, 0],
            definition: { id: "receiver", vitality: { maxHp: 100 } },
        }),
    ];
    let battle = createBattleState(fixtureBattlefield(units), undefined, executions);
    battle = activateSkill(battle, { unitId: 0, tick: 0 }, resources).state;
    const actionDependent = definition(
        "action-dependent",
        {},
        {
            onEnd: state => {
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
    battle = effects.install(battle, getUnit(battle, 1), actionDependent, {
        scopes: [{ type: "ACTION", executionId: 0 }],
    }).state;
    battle = effects.install(battle, getUnit(battle, 1), skillDependent, {
        scopes: [{ type: "SKILL", unitId: 0, activationId: 0 }],
    }).state;
    const content = definition(
        "nested-death",
        {},
        {
            onEnd(state, ctx) {
                trace.push("effect");
                state = resources.settleDamage(state, {
                    sourceUnitId: null,
                    targetUnitId: 0,
                    damageType: "TRUE",
                    operands: createDamageOperands(100),
                    tick: 1,
                }, ctx.call).state;
                trace.push("after-damage");
                assert.equal(getUnit(state, 0), undefined);
                assert.equal(getActionExecution(state.actionExecutions, 0), undefined);
                return state;
            },
        },
    );
    const installed = effects.install(battle, getUnit(battle, 0), content);
    battle = effects.end(installed.state, installed.value).state;
    assert.equal(getUnit(battle, 0), undefined);
    assert.deepEqual(getUnit(battle, 1).effects.instances, []);
    assert.ok(trace.indexOf("action-effect") < trace.indexOf("after-damage"));
    assert.ok(trace.indexOf("skill-effect") < trace.indexOf("after-damage"));
    assert.ok(trace.indexOf("skill") < trace.indexOf("after-damage"));
    assert.equal(battle.events.filter((event) => event.type === "ACTION_CANCELLED").length, 1);
    assert.equal(battle.events.filter((event) => event.type === "SKILL_FINISHED").length, 1);
});
