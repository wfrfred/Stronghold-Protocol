import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("Skill contributions keep attribute recovery, parameter programs and ammunition values distinct", async () => {
    const { default: ts } = await import("typescript");
    const directory = mkdtempSync(join(tmpdir(), "stronghold-skill-contributions-"));
    const source = (name) => JSON.stringify(fileURLToPath(new URL(`../../src/core/${name}.js`, import.meta.url)));
    const path = join(directory, "contributions.mts");
    try {
        writeFileSync(path, `
import * as attribute from ${source("tactical/unit/contribution/attribute")};
import type { State as BattleState } from ${source("tactical/battle/state")};
import type { Unit } from ${source("tactical/unit/unit")};
import type { Skill, State } from ${source("tactical/unit/capability/skill/capability")};
import { setAmmoContribution, setDurationContribution } from ${source("tactical/unit/capability/skill/capability")};
import * as sp from ${source("tactical/unit/capability/skill/sp")};
import type { Modifier } from ${source("tactical/unit/capability/skill/modifier")};
declare const state: State;
declare const resource: sp.State;
declare const uncertainKey: "capacity" | "recoverySpeed";
const program: Modifier = { priority: 0, apply: (battle, self, current) => {
    const fact: BattleState = battle;
    const host: Unit & Skill = self;
    return host.skill.active === null ? current : fact.tick;
} };
sp.setContribution(resource, "capacity", { id: "capacity", value: program });
sp.setContribution(resource, "requirement", { id: "requirement", value: program });
sp.setContribution(resource, "cost", { id: "cost", value: program });
sp.setContribution(resource, "recoverySpeed", { id: "speed", value: [attribute.create({ addition: 1 })] });
sp.setContribution(resource, "recoveryMultiplier", { id: "ratio", value: (battle, self) => [attribute.create({ finalScaler: self.skill.active === null ? 1 : battle.tick })] });
setDurationContribution(state, { id: "duration", value: program });
setAmmoContribution(state, { id: "ammo", value: { addition: 2, ratio: 0.5 } });
setAmmoContribution(state, { id: "live-ammo", value: (battle, self) => ({ addition: battle.tick, ratio: self.skill.active === null ? 0 : 0.5 }) });
// @ts-expect-error SP mechanism parameters use programs rather than attribute modifiers.
sp.setContribution(resource, "capacity", { id: "wrong", value: [attribute.create()] });
// @ts-expect-error recovery attributes do not accept mechanism parameter programs.
sp.setContribution(resource, "recoverySpeed", { id: "wrong", value: program });
// @ts-expect-error a key spanning incompatible payload families does not prove their pairing.
sp.setContribution(resource, uncertainKey, { id: "wrong", value: program });
// @ts-expect-error duration is a parameter program rather than an attribute value array.
setDurationContribution(state, { id: "wrong", value: [attribute.create()] });
// @ts-expect-error ammunition does not use parameter programs.
setAmmoContribution(state, { id: "wrong", value: program });
// @ts-expect-error an attribute Modifier is not an ammunition Modifier.
setAmmoContribution(state, { id: "wrong", value: attribute.create({ finalAddition: 2 }) });
// @ts-expect-error ammunition does not accept attribute modifier arrays.
setAmmoContribution(state, { id: "wrong", value: [attribute.create()] });
// @ts-expect-error ammunition payloads cannot be applied as attribute modifiers.
attribute.apply(10, [{ addition: 2, ratio: 0.5 }]);
`);
        const program = ts.createProgram([path], {
            noEmit: true, strict: true, exactOptionalPropertyTypes: true,
            noUncheckedIndexedAccess: true, target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
            skipLibCheck: true, types: [],
        });
        assert.deepEqual(ts.getPreEmitDiagnostics(program).map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")), []);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
