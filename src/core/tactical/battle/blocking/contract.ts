import type { Ref } from "../../../common/ref.js";
import type { Unit } from "../../unit/unit.js";
import type { Blocker } from "../../unit/capability/blocking/blocker.js";
import type { Blockable } from "../../unit/capability/blocking/blockable.js";

export interface Relation {
    readonly blocker: Ref<Unit & Blocker>;
    readonly blocked: Ref<Unit & Blockable>;
}

export interface Change {
    readonly type: "ACQUIRED" | "RELEASED";
    readonly relation: Relation;
}
