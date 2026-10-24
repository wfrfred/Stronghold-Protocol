import { projectBattlefieldSpatial } from "../../dist/core/tactical/battlefield/storage/indexes.js";
import { project } from "../../dist/core/tactical/battlefield/storage/effect-lifetimes.js";
import {
    reconcileSupportRelations,
    validateSupportRelations,
} from "../../dist/core/tactical/battlefield/support/relations.js";

export function maintainFully(previous, content) {
    if (content.supportRelations !== previous.supportRelations) {
        validateSupportRelations(content.units, content.supportRelations);
    }

    return {
        ...previous,
        ...content,
        supportRelations: reconcileSupportRelations(content.units, content.supportRelations),
        spatial: projectBattlefieldSpatial(previous.map, content.units),
        effectLifetimes: project(content.units.values()),
    };
}
