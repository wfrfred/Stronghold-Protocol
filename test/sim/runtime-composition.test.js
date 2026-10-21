import { damage as dealDamage, parameters } from "../helpers/vitality.js";
import { fixtureBattle } from "../helpers/unit.js";
import { healing } from "../helpers/vitality.js";
import { ref as unitRef } from "../../dist/core/tactical/unit/query.js";
import { setData as setEffectData } from "../../dist/core/tactical/unit/effect/effect.js";
import { initialize as initializeActionState } from "../../dist/core/tactical/unit/capability/action/capability.js";
import {
    setAttackContribution,
    removeAttackContribution,
} from "../../dist/core/tactical/unit/capability/offense/capability.js";
import {
    setHook as setDamageHook,
    removeHook as removeDamageHook,
} from "../../dist/core/tactical/battle/damage/hook.js";
import { get as getEffect } from "../../dist/core/tactical/unit/effect/operations.js";
import assert from "node:assert/strict";
import { test } from "node:test";
import { BattleRuntime } from "../../dist/core/tactical/battle/runtime.js";

import { createLegacyCombatSpec } from "../../dist/legacy/combat.js";
import { createDefinition } from "../../dist/core/tactical/unit/archetype/operator.js";
import { createDefinition as createEnemyDefinition } from "../../dist/core/tactical/unit/archetype/enemy.js";
import { initialize, placement } from "../helpers/unit.js";
import { seededPlacement } from "../helpers/aura.js";
import { createShapeGeometry } from "../../dist/core/tactical/geometry/shape.js";
import { createInput as createRouteDefinition } from "../../dist/core/tactical/battle/creation/route.js";
import { Definitions } from "../../dist/core/tactical/unit/action/definitions.js";
import { ref as actionRef, setState } from "../../dist/core/tactical/unit/action/action.js";
import * as actions from "../../dist/core/tactical/unit/action/operations.js";
import { install as installEffect, replaceEffect, end as endEffect } from "../../dist/core/tactical/unit/effect/operations.js";
import * as modifier from "../../dist/core/tactical/unit/contribution/attribute.js";
import { initialize as initializeVitalityState } from "../../dist/core/tactical/unit/capability/vitality/capability.js";
import { resolveAttackPower } from "../../dist/core/tactical/unit/capability/offense/query.js";
import {
    battlefieldView,
    getUnit,
    transitionUnit,
} from "../../dist/core/tactical/battle/state.js";
import { createDefinition as createProjectileDefinition } from "../../dist/core/tactical/battlefield/projectile/definition.js";
import {
    launchProjectile,
    getProjectile,
    ref as projectileRef,
    replaceProjectile,
} from "../../dist/core/tactical/battlefield/projectile/operations.js";
import { stopProjectile } from "../../dist/core/tactical/battlefield/projectile/settlement.js";

const hit = createShapeGeometry({
    shapes: [{ type: "CIRCLE", offset: [0, 0], radius: 0.1 }],
});
const range = {
    type: "SHAPES",
    geometry: createShapeGeometry({
        shapes: [{ type: "CIRCLE", offset: [0, 0], radius: 12 }],
    }),
};
const contactRange = {
    type: "SHAPES",
    geometry: createShapeGeometry({
        shapes: [{ type: "CIRCLE", offset: [0, 0], radius: 0.3 }],
    }),
};

function passive(id, hp = 100) {
    return {
        id,
        vitality: { maxHp: hp, defense: 0, resistance: 0 },
        offense: { attack: 10 },
        allegiance: { side: "ENEMY" },
        layer: { type: "GROUND" },
        hitbox: { geometry: hit },
    };
}

function actor(id, program) {
    return createDefinition({
        ...passive(id),
        allegiance: { side: "ALLY" },
        blocker: { capacity: 0, geometry: { radius: 0.1 } },
        action: { definitions: Definitions.empty().add(program) },
    });
}

function view(snapshot) {
    const units = new Map(snapshot.units.map((unit) => [unit.id, unit]));
    return {
        unitIds: [...units.keys()],
        getUnit: (id) => units.get(id),
        blockerOf: () => undefined,
        blockedBy: () => [],
    };
}

function effect(snapshot, unitId, ref) {
    return snapshot.units
        .find((unit) => unit.id === unitId)
        .effects.values().find((instance) => instance.definition.id === ref.id);
}

function scenario({ failure = null, cancelled = false } = {}) {

    const fault = { enabled: failure !== null };
    const launches = [];
    const scopes = [];
    const attempts = [];
    const reports = [];
    const rejected = [];
    let auraAddress;
    let aura;

    const registerBuff = (id, addition) => ({
        id,
        initialize: () => ({ starts: 0, enables: 0 }),
        onInstall(state, context) {
            return replaceEffect(
                state,
                context.ref,
                setEffectData(context.self, (current) => ({
                    ...current,
                    starts: current.starts + 1,
                })),
            );
        },
        onEnable(state, context) {
            state = replaceEffect(
                state,
                context.ref,
                setEffectData(context.self, (current) => ({
                    ...current,
                    enables: current.enables + 1,
                })),
            );
            const id = `effect:${context.self.id}`;
            return transitionUnit(state, context.ref.host.id, (unit) => {
                const next = ({ ...unit, offense: setAttackContribution(unit.offense, {
                    id,
                    value: [modifier.create({ finalAddition: addition })],
                }) });
                return next;
            });
        },
        onDisable(state, context) {
            const id = `effect:${context.self.id}`;
            return transitionUnit(state, context.ref.host.id, (unit) => {
                const next = ({ ...unit, offense: removeAttackContribution(unit.offense, id) });
                return next;
            });
        },
    });
    const marker = registerBuff("receiver-mark", 3);
    const marked = (unit) => unit.effects.values().some(
        (instance) => instance.definition === marker && instance.status === "ACTIVE",
    );
    const scoped = registerBuff("execution-power", 2);
    const pulse = registerBuff("release-power", 1);
    const receiverOutput = registerBuff("aura-receiver", 5);
    const receiver = {
        ...receiverOutput,
        initialize: () => ({ ...receiverOutput.initialize(), uses: 0 }),
        onInstall(state, context) {
            state = receiverOutput.onInstall(state, context);
            const ref = context.ref;
            return transitionUnit(state, ref.host.id, (unit) =>
                ({ ...unit, vitality: setDamageHook(unit.vitality, {
                    id: `receiver:${ref.id}`,
                    stage: "receiving",
                    priority: 0,
                    accepts: (battle, invocation) =>
                        getUnit(battle, ref.host.id)?.effects.values().find(
                            (instance) => instance.id === ref.id,
                        )?.status === "ACTIVE",
                    invoke(state, invocation, pending) {
                        assert.ok(getEffect(state, auraAddress).data.remaining > 0);
                        state = replaceEffect(
                            state,
                            auraAddress,
                            setEffectData(getEffect(state, auraAddress), (current) => ({
                                ...current,
                                remaining: current.remaining - 1,
                                consumed: current.consumed + 1,
                            })),
                        );
                        state = replaceEffect(
                            state,
                            ref,
                            setEffectData(getEffect(state, ref), (current) => ({
                                ...current,
                                uses: current.uses + 1,
                            })),
                        );
                        if (cancelled) {
                            rejected.push({ type: "SKIPPED", reason: "CONTENT_CONDITION" });
                            state = healing(
                                state,
                                {
                                    source: { id: 0 },
                                    target: ref.host,
                                    parameters: { power: 4, multiplier: 1 },
                                },
                            ).state;
                        } else {
                            const installed = installEffect(
                                state,
                                unitRef(getUnit(state, ref.host.id)),
                                marker,
                                {
                                    source: 0,
                                    scopes: [{ type: "EFFECT", ref }],
                                },
                            );
                            assert.ok(installed.value);
                            state = installed.state;
                        }
                        const quota = getEffect(state, auraAddress).data;
                        attempts.push({
                            address: ref,
                            quota: { remaining: quota.remaining, consumed: quota.consumed },
                            marked: marked(getUnit(state, ref.host.id)),
                        });
                        return {
                            state,
                            value: {
                                    ...pending,
                                    amount:
                                        fault.enabled && failure === "invalid-damage"
                                            ? NaN
                                            : pending.amount,
                                    cancellation: cancelled
                                        ? { reason: "BLOCKED" }
                                        : null,
                                },
                        };
                    },
                }) }),
            );
        },
        onEnd(state, context) {
            return transitionUnit(state, context.ref.host.id, (unit) =>
                ({ ...unit, vitality: removeDamageHook(unit.vitality, `receiver:${context.self.id}`) }),
            );
        },
    };
    aura = {
        id: "combined-aura",
        initialize: () => ({ remaining: 3, consumed: 0, receivers: [] }),
        onInstall(state, context) {
            auraAddress = context.ref;
            return state;
        },
        onTick(state, context) {
            if (context.tick >= 3) {
                return endEffect(state, context.ref, "AURA_FINISHED");
            }
            for (const unitId of battlefieldView(state).unitIds) {
                const self = getEffect(state, context.ref);
                if (self === undefined || self.status === "ENDING") return state;
                if (self.data.receivers.some((binding) => binding.unitId === unitId)) continue;
                state = replaceEffect(
                    state,
                    context.ref,
                    setEffectData(self, (current) => ({
                        ...current,
                        receivers: [...current.receivers, { unitId, ref: null, attempts: 1 }],
                    })),
                );
                const installed = installEffect(
                    state,
                    unitRef(getUnit(state, unitId)),
                    receiver,
                    {
                        source: context.ref.host.id,
                        scopes: [{ type: "EFFECT", ref: context.ref }],
                    },
                                    );
                state = installed.state;
                const ref = installed.value;
                assert.ok(ref);
                state = replaceEffect(
                    state,
                    context.ref,
                    setEffectData(getEffect(state, context.ref), (current) => ({
                        ...current,
                        receivers: current.receivers.map((binding) =>
                            binding.unitId === unitId ? { ...binding, ref } : binding,
                        ),
                    })),
                );
            }
            return state;
        },
    };
    const shell = createProjectileDefinition({
        id: "combined-shell",
        initialize: () => ({ contacts: 0 }),
        acceptsContact: (context, unit) =>
            unit.id === context.projectile.traceTarget && !marked(unit),
        contact: (state, context) => {
            scopes.push(context);
            const current = getProjectile(state, projectileRef(context.projectile));
            state = replaceProjectile(state, {
                ...current,
                state: { contacts: current.state.contacts + 1 },
            });
            const damaged = dealDamage(state, { source: { id: context.projectile.source }, target: { id: context.targetUnitId }, parameters: parameters(context.projectile.cachedAtk, "TRUE") });
            state = damaged.state;
            reports.push(damaged.value);
            state = stopProjectile(
                state,
                projectileRef(context.projectile),
                context.tick,
                "EXPLICIT",
                            );
            if (fault.enabled && failure === "late-projectile") {
                const auraState = getUnit(state, 0).effects.values().find(
                    (instance) => instance.definition === aura,
                ).data;
                assert.deepEqual(
                    auraState.receivers.map((binding) => binding.unitId),
                    [0, 1, 2, 3],
                );
                assert.equal(getUnit(state, 1).vitality.hp, 83);
                assert.equal(marked(getUnit(state, 1)), true);
                assert.equal(getUnit(state, 2).action.states.get("launch").cooldown.readyAtTick, 101);
                throw new Error("late composition failure");
            }
            return state;
        },
    });
    const program = primary => ({
        id: "launch", intervalTicks: 100, speed: 100,
        initialize: state => ({ state, value: {} }),
        start: state => ({ state, value: { emitted: 0 } }),
        step(state, self) {
            if (self.state.emitted === 0) {
                self = setState(self, { emitted: 1 });
                state = actions.replace(state, self);
                state = installation(state, self, scoped);
                state = launch(state, self, primary ? 1 : 3);
            }
            if (primary && self.state.emitted === 1 && state.tick > self.startedAtTick) {
                self = setState(self, { emitted: 2 });
                state = actions.replace(state, self);
                state = installation(state, self, pulse);
                state = launch(state, self, 3);
            }
            return { state, value: state.tick >= self.startedAtTick + (primary ? 3 : 4) };
        },
    });
    const primary = actor("primary-launcher", program(true));
    const sibling = actor("later-launcher", program(false));
    const siblingAction = initializeActionState(fixtureBattle(0), sibling.action).value;
    const delayedSiblingAction = {
        ...siblingAction,
        states: new Map(siblingAction.states).set("launch", {
            ...siblingAction.states.get("launch"),
            cooldown: { periodTicks: 100, readyAtTick: 1 },
        }),
    };
    const scheduled = {
        ...createEnemyDefinition({
            id: "managed-target",
            vitality: { maxHp: 17, defense: 0, resistance: 0 },
            locomotion: {
                halfBodyWidth: 0, minSpeed: 0, speed: 0,
                steeringParameters: { steeringFactor: 1, maxSteeringForce: 100 },
            },
        }),
        ...passive("managed-target", 17),
    };
    const route = createRouteDefinition({
        pathMotionMode: "WALK",
        startPosition: [0, 6],
        endPosition: [0, 7],
        spawnOffset: [0, 0],
        spawnRandomRange: [0.25, 0.25],
        checkpoints: [{ type: "WAIT_FOR_TICKS", durationTicks: 100 }],
        allowDiagonalMove: false,
        visitEveryTileCenter: false,
        visitEveryNodeCenter: false,
        visitEveryCheckPoint: true,
    });
    const installation = (state, context, program) =>
        installEffect(
            state,
            unitRef(getUnit(state, context.source.id)),
            program,
            {
                source: context.source.id,
                scopes: [{ type: "ACTION", ref: actionRef(context) }],
            },
        ).state;
    const launch = (state, context, targetUnitId) => {
        const source = getUnit(state, context.source.id);
        const target = getUnit(state, targetUnitId);
        const launched = launchProjectile(state, shell, {
            source: source.id,
            traceTarget: targetUnitId,
            position: source.position,
            destination: target.position,
            cachedAtk: resolveAttackPower(source.id, battlefieldView(state)),
            speedPerTick: 1,
            contactRange,
            stopDelayTicks: 0,
            expiresAtTick: null,
        }, state.tick);
        launches.push({ id: launched.value.id, executionId: context.id, targetUnitId });
        return launched.state;
    };
    const runtime = new BattleRuntime(
        {
            ...createLegacyCombatSpec({
                rows: 3,
                columns: 8,
                operators: [],
                enemies: [],
                maxTicks: 20,
                seed: 17,
            }),
            initialUnits: [
                seededPlacement(
                    aura,
                    initialize({ id: 0, definition: primary, position: [0, 0] }),
                ),
                placement({
                    definition: passive("first-target"),
                    position: [1, 0],
                    ...(cancelled
                        ? {
                              states: {
                                  vitality: {
                                      ...initializeVitalityState(fixtureBattle(0), { maxHp: 100, defense: 0, resistance: 0 }).value,
                                      hp: 40,
                                  },
                              },
                          }
                        : {}),
                }),
                placement({
                    definition: sibling,
                    position: [0, 2],
                    states: { action: delayedSiblingAction },
                }),
            ],
            initialMechanisms: [],
            schedule: {
                type: "TIMELINE",
                spawns: [
                    {
                        definition: scheduled,
                        route,
                        tick: 1,
                        timing: { waveStartedAtTick: 0, fragmentStartedAtTick: 0 },
                        alwaysCheckCurrentPoint: true,
                        notCountInTotal: false,
                    },
                ],
            },
        },
    );
    return {
        runtime,
        fault,
        launches,
        attempts,
        scopes,
        reports,
        rejected,
        aura: aura,
        receiver: receiver,
        marker: marker,
        scoped: scoped,
        pulse: pulse,
    };
}

test("runtime composition: late exceptions and invalid settlement propagate without publishing any domain", () => {
    for (const failure of ["late-projectile", "invalid-damage"]) {
        const failed = scenario({ failure });
        failed.runtime.step();
        const before = failed.runtime.snapshot();
        const maps = failed.runtime.navigation;
        assert.equal(before.actions.nextId, 1);
        assert.equal(before.projectiles.nextProjectileId, 1);
        assert.equal(before.execution.nextUnitId, 3);
        assert.equal(before.spawning.spawnedCount, 0);
        assert.equal(effect(before, 0, failed.scoped).data.starts, 1);
        assert.equal(resolveAttackPower(0, view(before)), 17);

        assert.throws(
            () => failed.runtime.step(),
            {
                "late-projectile": /late composition failure/,
                "invalid-damage": RangeError,
            }[failure],
        );
        assert.deepEqual(failed.runtime.snapshot(), before);
        assert.equal(failed.runtime.navigation, maps);
        assert.deepEqual(
            failed.launches.map((launch) => [launch.id, launch.executionId]),
            [
                [0, 0],
                [1, 0],
                [2, 1],
            ],
        );
        assert.deepEqual(failed.attempts, [
            {
                address: { host: { id: 1 }, id: 0 },
                quota: { remaining: 2, consumed: 1 },
                marked: true,
            },
        ]);
    }
});

test("runtime composition: a successful battle preserves identities, snapshots and the terminal trace", () => {
    const run = scenario();
    const replay = scenario();
    const serialized = (value) => JSON.parse(JSON.stringify(value));
    const first = run.runtime.step();
    assert.deepEqual(serialized(first), serialized(replay.runtime.step()));
    const events = [...first.events];
    const before = run.runtime.snapshot();
    const second = run.runtime.step();
    assert.deepEqual(serialized(second), serialized(replay.runtime.step()));
    assert.deepEqual(serialized(run.runtime.snapshot()), serialized(replay.runtime.snapshot()));
    events.push(...second.events);
    const after = run.runtime.snapshot();
    assert.equal(effect(before, 0, run.aura).definition, run.aura);
    assert.equal(effect(after, 0, run.aura).definition, run.aura);
    assert.equal(effect(after, 1, run.receiver).definition, run.receiver);
    assert.notEqual(after.execution.rngState, before.execution.rngState);
    assert.equal(after.execution.nextUnitId, 4);
    assert.equal(after.spawning.cursor, 1);
    assert.equal(after.spawning.spawnedCount, 1);
    assert.deepEqual(after.spawning.managedFinalUnitIds, [3]);
    assert.equal(after.actions.nextId, 2);
    assert.equal(after.actions.instances[0].state.emitted, 2);
    assert.equal(after.projectiles.nextProjectileId, 3);
    assert.deepEqual(
        after.projectiles.instances.map((projectile) => projectile.id),
        [1, 2],
    );
    assert.deepEqual(
        after.projectiles.instances.map((projectile) => projectile.cachedAtk),
        [18, 17],
    );
    assert.equal(resolveAttackPower(0, view(after)), 18);
    assert.equal(effect(after, 0, run.aura).data.remaining, 2);
    assert.equal(effect(after, 0, run.aura).data.consumed, 1);
    assert.deepEqual(
        effect(after, 0, run.aura).data.receivers.map((binding) => binding.attempts),
        [1, 1, 1, 1],
    );
    assert.deepEqual(effect(after, 3, run.receiver).data, { starts: 1, enables: 1, uses: 0 });
    assert.deepEqual(effect(after, 1, run.receiver).data, { starts: 1, enables: 1, uses: 1 });
    assert.equal(effect(after, 1, run.marker).id, 1);
    assert.deepEqual(effect(after, 1, run.marker).scopes, [
        { type: "EFFECT", ref: { host: { id: 1 }, id: 0 } },
    ]);
    assert.equal(after.units.find((unit) => unit.id === 1).effects.nextId, 2);
    assert.equal(before.units.find((unit) => unit.id === 1).effects.nextId, 1);
    assert.equal(
        effect(after, 1, run.marker)?.status === "ACTIVE",
        true,
    );
    assert.equal(after.units.find((unit) => unit.id === 1).vitality.hp, 83);
    assert.deepEqual(
        run.launches.map((launch) => launch.id),
        [0, 1, 2],
    );
    assert.deepEqual(
        before.units.map((unit) => unit.id),
        [0, 1, 2],
    );
    assert.equal(effect(before, 0, run.aura).data.remaining, 3);
    assert.equal(effect(before, 0, run.aura).data.consumed, 0);
    assert.deepEqual(
        effect(before, 0, run.aura).data.receivers.map((binding) => binding.unitId),
        [0, 1, 2],
    );
    assert.equal(before.units[1].vitality.hp, 100);

    while (run.runtime.result === null) {
        const actual = run.runtime.step();
        assert.deepEqual(serialized(actual), serialized(replay.runtime.step()));
        assert.deepEqual(serialized(run.runtime.snapshot()), serialized(replay.runtime.snapshot()));
        events.push(...actual.events);
        if (run.runtime.snapshot().tickIndex === 4) {
            const cleaned = run.runtime.snapshot();
            assert.equal(effect(cleaned, 0, run.aura), undefined);
            assert.ok(
                cleaned.units.every((unit) => effect(cleaned, unit.id, run.receiver) === undefined),
            );
            assert.equal(effect(before, 0, run.aura).status, "ACTIVE");
            assert.equal(
                effect(cleaned, 1, run.marker)?.status === "ACTIVE",
                false,
            );
            assert.equal(resolveAttackPower(0, view(cleaned)), 10);
            assert.equal(effect(cleaned, 0, run.scoped), undefined);
            assert.equal(effect(cleaned, 0, run.pulse), undefined);
        }
        if (run.runtime.snapshot().tickIndex === 5) {
            const finalized = run.runtime.snapshot();
            assert.equal(effect(finalized, 0, run.scoped), undefined);
            assert.equal(effect(finalized, 0, run.pulse), undefined);
            assert.equal(effect(finalized, 1, run.marker), undefined);
        }
    }
    assert.deepEqual(
        events.filter((event) => event.type === "ENEMY_SPAWNED").map((event) => event.unitId),
        [3],
    );
    assert.deepEqual(
        events
            .filter((event) => event.type === "PROJECTILE_HIT")
            .map((event) => [event.projectileId, event.targetUnitId]),
        [
            [0, 1],
            [1, 3],
        ],
    );
    assert.deepEqual(
        events
            .filter((event) => event.type === "DAMAGE")
            .map((event) => [event.targetUnitId, event.amount]),
        [
            [1, 17],
            [3, 17],
        ],
    );
    assert.equal(run.reports.at(-1).received.amount, 18);
    assert.equal(run.reports.at(-1).application.hpLoss, 17);
    assert.equal(run.runtime.result.reason, "SCHEDULE_COMPLETED");
    assert.equal(run.runtime.result.spawnedCount, 1);
    assert.equal(run.runtime.result.unspawnedCount, 0);
    assert.equal(run.runtime.result.completedRouteCount, 0);
    assert.deepEqual(run.runtime.result.remainingUnitIds, [0, 1, 2]);
    assert.ok(run.runtime.result.elapsedTicks >= 7);
    const final = run.runtime.snapshot();
    assert.deepEqual(run.runtime.step(), { events: [], result: run.runtime.result });
    assert.deepEqual(run.runtime.snapshot(), final);
});

test("runtime composition: content conditions skip installation while cancelled damage retains consumption and healing", () => {
    const run = scenario({ cancelled: true });
    run.runtime.step();
    const reached = run.runtime.step();
    const after = run.runtime.snapshot();
    assert.deepEqual(run.rejected, [
        {
            type: "SKIPPED",
            reason: "CONTENT_CONDITION",
        },
    ]);
    assert.equal(run.reports[0].kind, "CANCELLED");
    assert.deepEqual(run.reports[0].received.cancellation, { reason: "BLOCKED" });
    assert.deepEqual(
        reached.events
            .filter((event) => ["HEAL", "DAMAGE"].includes(event.type))
            .map((event) => [event.type, event.targetUnitId, event.amount, event.hp]),
        [
            ["HEAL", 1, 4, 44],
            ["DAMAGE", 1, 0, 44],
        ],
    );
    assert.equal(after.tickIndex, 2);
    assert.equal(after.execution.nextUnitId, 4);
    assert.equal(after.spawning.spawnedCount, 1);
    assert.equal(after.actions.nextId, 2);
    assert.equal(after.projectiles.nextProjectileId, 3);
    assert.equal(effect(after, 0, run.aura).data.remaining, 2);
    assert.equal(effect(after, 0, run.aura).data.consumed, 1);
    assert.equal(effect(after, 1, run.receiver).data.uses, 1);
    assert.equal(effect(after, 1, run.marker), undefined);
    assert.equal(
        effect(after, 1, run.marker)?.status === "ACTIVE",
        false,
    );
    assert.equal(resolveAttackPower(1, view(after)), 15);
    assert.equal(after.units.find((unit) => unit.id === 1).effects.nextId, 1);
    while (run.runtime.result === null) run.runtime.step();
    const final = run.runtime.snapshot();
    assert.equal(final.result.reason, "SCHEDULE_COMPLETED");
    assert.equal(final.units.find((unit) => unit.id === 1).vitality.hp, 44);
    assert.equal(
        effect(final, 1, run.marker)?.status === "ACTIVE",
        false,
    );
    assert.equal(resolveAttackPower(1, view(final)), 10);
});
