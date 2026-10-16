import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

test("direct Effect definitions type host capabilities, private state and immutable outputs", async () => {
    const { default: ts } = await import("typescript");
    const directory = mkdtempSync(join(tmpdir(), "stronghold-effect-types-"));
    const module = (name) =>
        JSON.stringify(
            fileURLToPath(new URL(`../../src/core/tactical/${name}.js`, import.meta.url)),
        );
    const path = join(directory, "contract.mts");
    writeFileSync(
        path,
        `
import { initialize } from ${module("unit/initialize")};
import type { Unit } from ${module("unit/unit")};
import type { State as BattleState } from ${module("battle/state")};
import type { Vitality } from ${module("unit/capability/vitality/capability")};
import { setMaxHpContribution } from ${module("unit/capability/vitality/capability")};
import { setAttackContribution, type Offense } from ${module("unit/capability/offense/capability")};
import { setCapacityContribution, canBlock, type Rule as BlockerRule, type Blocker } from ${module("unit/capability/blocking/blocker")};
import { setVolumeContribution, canBeBlocked, type Rule as BlockableRule, type Blockable } from ${module("unit/capability/blocking/blockable")};
import { setMoveSpeedContribution, type RoutedLocomotion, type RouteControlState } from ${module("unit/capability/locomotion/capability")};
import type { Context, Definition } from ${module("unit/effect/definition")};
import { install, replaceEffect, get } from ${module("unit/effect/operations")};
import { setData, type Effect } from ${module("unit/effect/effect")};
import { Effects } from ${module("unit/effect/effects")};
import type { Contribution, Input } from ${module("unit/contribution/contribution")};
import { ref as unitRef, type Context as QueryContext } from ${module("unit/query")};
const host=initialize(battle, {id:1,position:[0,0],definition:{id:'host',vitality:{maxHp:100}}}).value;
const content: Definition<{charges:number},Vitality> = {
 id:'shield',initialize:()=>({charges:2}),
 onTick(state,context) {
   const hp:number=context.unit.vitality.hp;
   const next=setData(context.self,current=>({charges:current.charges-1}));
   // @ts-expect-error private state remains specific to this definition.
   setData(context.self,{missing:1});
   // @ts-expect-error stored values are readonly.
   context.self.status='ENDING';
   // @ts-expect-error shared host state must use immutable transitions.
   context.unit.vitality.hp=hp;
   return replaceEffect(state,context.ref,next);
 }
};
declare const battle:BattleState;
const installed=install(battle,unitRef(host),content);
const ref=installed.value;
const bare=initialize(battle, {id:2,position:[0,0],definition:{id:'bare'}}).value;
// @ts-expect-error required host capabilities must be present.
install(battle,unitRef(bare),content);
if(ref!==undefined) {
 const found=get(battle,ref);
 if(found!==undefined){
   const charges:number=found.data.charges;
   const typed:Effect<{charges:number},Vitality>=found;
   setData(found,{charges:5});
   // @ts-expect-error state transitions preserve the Effect's private state type.
   setData(found,{charges:'five'});
 }
}
declare const shield:Effect<{charges:number},Vitality>;
declare const poison:Effect<{damage:number}>;
const mixed=Effects.empty().add(shield).add(poison);
declare function contextOf<S extends object,H extends object>(self:Effect<S,H>):Context<S,H>;
const readState:BattleState|undefined=mixed.read(shield.id,effect=>
 effect.definition.onTick?.(battle,contextOf(effect))??battle,
);
// @ts-expect-error a polymorphic reader cannot expose a falsely universal Effect.
const leakedEffect:Effect|undefined=mixed.read(shield.id,effect=>effect);
// @ts-expect-error a polymorphic reader cannot expose a falsely universal Definition.
const leakedDefinition:Definition<object,object>|undefined=mixed.read(shield.id,effect=>effect.definition);
const restored=mixed.get(shield.id,content);
if(restored!==undefined){
 const charges:number=restored.data.charges;
 const typed:Effect<{charges:number},Vitality>=restored;
}
const untyped=mixed.get(shield.id);
if(untyped!==undefined){
 // @ts-expect-error a bare ID returns generic data without a claimed shape.
 const charges:number=untyped.data.charges;
 // @ts-expect-error erased storage views do not claim a callable lifecycle definition.
 untyped.definition.onTick;
 // @ts-expect-error erased storage views do not claim a typed initializer.
 untyped.definition.initialize;
 const definitionId:string=untyped.definition.id;
}
for(const stored of mixed.values()){
 // @ts-expect-error heterogeneous collection traversal cannot invoke definition callbacks.
 stored.definition.onTick;
 // @ts-expect-error heterogeneous collection traversal cannot initialize generic Effect data.
 stored.definition.initialize;
 const definitionId:string=stored.definition.id;
}
// @ts-expect-error an ID alone cannot claim a private data type.
host.effects.get<{charges:number},Vitality>(0);
declare const capabilityHost:Unit & Vitality & Offense & Blocker & Blockable & RoutedLocomotion;
const blockerRule:BlockerRule={id:'blocker',allows:self=>self.blocker.capacity.length===0};
const blockableRule:BlockableRule={id:'blockable',allows:self=>self.blockable.volume.length===0};
canBlock(capabilityHost);
canBeBlocked(capabilityHost);
// @ts-expect-error blocking queries require the capability at the call boundary.
canBlock(bare);
// @ts-expect-error blockable queries require the capability at the call boundary.
canBeBlocked(bare);
// @ts-expect-error eligibility is expressed through Rules.
capabilityHost.blocker.enabled;
// @ts-expect-error eligibility is expressed through Rules.
capabilityHost.blockable.enabled;
const fixed:Contribution={id:'fixed',value:[]};
const dynamic:Contribution<Input<QueryContext>>={id:'dynamic',value:()=>[]};
setVolumeContribution(capabilityHost.blockable,fixed);
// @ts-expect-error blocking volume requires settled static values.
setVolumeContribution(capabilityHost.blockable,dynamic);
const vitality=setMaxHpContribution(capabilityHost.definition.vitality,capabilityHost.vitality,fixed);
const changed={...capabilityHost,vitality};
const hp:number=changed.vitality.hp;
const attack:number=changed.definition.offense.attack;
const maxHp:number=changed.definition.vitality.maxHp;
const retainedRoute:RouteControlState=changed.locomotion.mainRoute;
setAttackContribution(capabilityHost.offense,dynamic);
// @ts-expect-error MaxHP cannot coordinate HP from a query-time closure.
setMaxHpContribution(capabilityHost.definition.vitality,capabilityHost.vitality,dynamic);
// @ts-expect-error blocking capacity requires settled static values.
setCapacityContribution(capabilityHost.blocker,dynamic);
const movement={
 ...capabilityHost.locomotion,
 ...setMoveSpeedContribution(capabilityHost.locomotion,dynamic),
};
const mainRoute:RouteControlState=movement.mainRoute;
const crossCapability:Definition<{bonus:number},Vitality & Offense>={
 id:'low-hp-attack',initialize:()=>({bonus:10}),
 onEnable(state,context){
  const hp:number=context.unit.vitality.hp;
  const maxHp:number=context.unit.definition.vitality.maxHp;
  const attack:number=context.unit.definition.offense.attack;
  const offense=setAttackContribution(context.unit.offense,fixed);
  const host:Unit & Vitality & Offense={...context.unit,offense};
  return state;
 },
};
const combined=initialize(battle, {id:3,position:[0,0],definition:{id:'combined',vitality:{maxHp:100},offense:{attack:20}}}).value;
install(battle,unitRef(combined),crossCapability);
// @ts-expect-error the concrete Effect requires both capability pairs.
install(battle,unitRef(host),crossCapability);
`,
    );
    try {
        const program = ts.createProgram([path], {
            noEmit: true,
            strict: true,
            exactOptionalPropertyTypes: true,
            noUncheckedIndexedAccess: true,
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.NodeNext,
            moduleResolution: ts.ModuleResolutionKind.NodeNext,
            skipLibCheck: true,
            types: [],
        });
        assert.deepEqual(
            ts
                .getPreEmitDiagnostics(program)
                .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")),
            [],
        );
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
