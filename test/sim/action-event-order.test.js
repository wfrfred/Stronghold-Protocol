import assert from "node:assert/strict";
import { test } from "node:test";
import { battle, unit, actionDefinition } from "../helpers/action-fixture.js";
import { getUnit } from "../../dist/core/tactical/battle/state.js";
import { maintain } from "../../dist/core/tactical/battlefield/storage/state.js";
import { ref as unitRef } from "../../dist/core/tactical/unit/query.js";
import { start } from "../../dist/core/tactical/unit/action/operations.js";

test("action event order: lethal output settles support loss before action completion", () => {
    const definition = actionDefinition(10, { markerId: "damage" });
    const source = unit(0, { action: definition });
    const support = {
        ...unit(1, {
            hp: 1,
            tileBinding: {
                heightType: "HIGHLAND",
                buildableType: "ALL",
                advancedBuildableMask: null,
            },
        }),
        occupancy: { claims: [{ position: [0, 1], slot: "SUPPORT", type: "PRESENT" }] },
    };
    const recipient = {
        ...unit(2),
        occupancy: { claims: [{ position: [0, 1], slot: "DEPLOYMENT", type: "PRESENT" }] },
    };
    let state = battle(source, support, recipient);
    state = {
        ...state,
        battlefield: maintain(state.battlefield, { ...state.battlefield, supportRelations: [{ supportedUnitId: 2, supportUnitId: 1 }] }),
    };
    const result = start(state, unitRef(getUnit(state, 0)), definition);
    const types = result.state.events.map((event) => event.type);
    assert.ok(types.indexOf("DAMAGE") < types.indexOf("SUPPORT_LOST"));
    assert.ok(types.indexOf("SUPPORT_LOST") < types.indexOf("ACTION_FINISHED"));
    const lost = result.state.events.find((event) => event.type === "SUPPORT_LOST");
    assert.equal(lost.supportedUnitId, 2);
    assert.equal(lost.supportUnitId, 1);
    assert.equal(getUnit(result.state, 1), undefined);
    assert.equal(getUnit(result.state, 2).vitality.hp, 100);
});
