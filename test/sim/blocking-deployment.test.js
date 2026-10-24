import assert from "node:assert/strict";
import { test } from "node:test";
import { acquire, blockedIds, change, fixture, holder, hook, ownerId, target } from "../helpers/blocking.js";
import { getUnit } from "../../dist/core/tactical/battle/state.js";
import { leave } from "../../dist/core/tactical/battle/execution/unit.js";
import { search } from "../../dist/core/tactical/battle/blocking/operations.js";
import { setHook } from "../../dist/core/tactical/unit/capability/blocking/blocker.js";
import { createDefinition } from "../../dist/core/tactical/unit/capability/deployable/capability.js";

test("retreat refunds use current deployment state after blocking release hooks", () => {
    const blocker = holder(10, {
        definition: {
            deployable: createDefinition({
                cost: 20,
                redeployTicks: 0,
                slots: 1,
                buildableType: "ALL",
            }),
        },
    });
    let battle = fixture([blocker, target()]);
    battle = change(battle, 10, unit => ({
        ...unit,
        deployable: { ...unit.deployable, refundAllowed: true },
        blocker: setHook(unit.blocker, "released", hook("disable-refund", current =>
            change(current, 10, latest => ({
                ...latest,
                deployable: { ...latest.deployable, refundAllowed: false },
            })),
        )),
    }));
    battle = acquire(battle);
    const before = battle;
    battle = leave(battle, 10, "RETREAT");

    assert.equal(battle.deployment.dp, before.deployment.dp);
    assert.equal(battle.removedUnits.find(({ unitId }) => unitId === 10).unit.deployable.refundAllowed, false);
    assert.equal(getUnit(before, 10).deployable.refundAllowed, true);
    assert.equal(ownerId(battle), undefined);
});

test("release hooks cannot reacquire a leaving target or restart its departure", () => {
    let calls = 0;
    let battle = fixture([holder(), target()]);
    battle = change(battle, 10, unit => ({
        ...unit,
        blocker: setHook(unit.blocker, "released", hook("search-during-leave", current => {
            calls++;
            assert.equal(getUnit(current, 20).lifecycle, "LEAVING");
            assert.equal(ownerId(current), undefined);
            assert.deepEqual(blockedIds(current), []);
            current = leave(current, 20, "SCRIPT");
            return search(current, { id: 10 });
        })),
    }));
    battle = acquire(battle);
    const before = battle;
    battle = leave(battle, 20, "DEATH");

    assert.equal(calls, 1);
    assert.equal(getUnit(battle, 20), undefined);
    assert.deepEqual(blockedIds(battle), []);
    assert.equal(battle.removedUnits.length, 1);
    assert.equal(battle.removedUnits[0].reason, "DEATH");
    assert.deepEqual(battle.events.map(({ type }) => type), ["BLOCKING_ACQUIRED", "BLOCKING_RELEASED"]);
    assert.equal(ownerId(before), 10);
});
