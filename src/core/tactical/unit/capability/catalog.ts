import * as action from "./action/capability.js";
import * as allegiance from "./allegiance/capability.js";
import * as blockable from "./blocking/blockable.js";
import * as blocker from "./blocking/blocker.js";
import * as deployable from "./deployable/capability.js";
import * as elemental from "./elemental/capability.js";
import * as locomotion from "./locomotion/capability.js";
import * as occupancy from "./occupancy/capability.js";
import * as offense from "./offense/capability.js";
import * as presence from "./presence/capability.js";
import * as skill from "./skill/capability.js";
import * as spatial from "./spatial/capability.js";
import * as targetable from "./targetable/capability.js";
import * as tileBinding from "./tile-binding/capability.js";
import * as vitality from "./vitality/capability.js";

export const initializers = {
    deployable: deployable.initialize,
    vitality: vitality.initialize,
    offense: offense.initialize,
    action: action.initialize,
    skill: skill.initialize,
    elemental: elemental.initialize,
    allegiance: allegiance.initialize,
    spatial: spatial.initializeSpatialState,
    hit: spatial.initializeHitState,
    blocker: blocker.initialize,
    blockable: blockable.initialize,
    locomotion: locomotion.initialize,
    spatialPresence: presence.initialize,
    occupancy: occupancy.initialize,
    targetable: targetable.initialize,
    tileBinding: tileBinding.initialize,
} as const;

export type Definitions = {
    readonly [K in keyof typeof initializers]: Parameters<(typeof initializers)[K]>[1];
};

export type States = {
    readonly [K in keyof typeof initializers]: ReturnType<(typeof initializers)[K]>["value"];
};

type SelectedKeys<D> = {
    [K in keyof States]: D extends Readonly<Record<K, Definitions[K]>> ? K : never;
}[keyof States];

export type Product<D> = {
    readonly definition: Pick<Definitions, SelectedKeys<D>>;
} & Pick<States, SelectedKeys<D>>;
