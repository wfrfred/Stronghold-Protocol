import js from "@eslint/js";
import stylistic from "@stylistic/eslint-plugin";
import { defineConfig } from "eslint/config";
import eslintConfigPrettier from "eslint-config-prettier/flat";
import tseslint from "typescript-eslint";

const declarations = [
    "function",
    "function-overload",
    "class",
    "interface",
    "type",
    "enum",
    "export",
];
const exportedOverload = {
    selector: "ExportNamedDeclaration[declaration.type='TSDeclareFunction']",
};
const exportedFunction = {
    selector: "ExportNamedDeclaration[declaration.type='FunctionDeclaration']",
};

export default defineConfig({
    files: ["src/**/*.ts"],
    extends: [
        js.configs.recommended,
        tseslint.configs.strictTypeChecked,
        tseslint.configs.stylisticTypeChecked,
        eslintConfigPrettier,
    ],
    languageOptions: {
        parserOptions: {
            projectService: true,
            tsconfigRootDir: import.meta.dirname,
        },
    },
    plugins: { "@stylistic": stylistic },
    rules: {
        curly: ["error", "all"],
        "no-duplicate-imports": "error",
        "no-nested-ternary": "error",
        "@typescript-eslint/switch-exhaustiveness-check": "error",
        "@typescript-eslint/no-non-null-assertion": "off",
        "@typescript-eslint/no-unnecessary-condition": [
            "error",
            { allowConstantLoopConditions: "only-allowed-literals" },
        ],
        "@typescript-eslint/restrict-template-expressions": [
            "error",
            {
                allowAny: false,
                allowBoolean: true,
                allowNever: false,
                allowNullish: false,
                allowNumber: true,
                allowRegExp: false,
            },
        ],
        "@typescript-eslint/unified-signatures": [
            "error",
            { ignoreDifferentlyNamedParameters: true },
        ],
        "@stylistic/padding-line-between-statements": [
            "error",
            { blankLine: "always", prev: "*", next: "return" },
            { blankLine: "always", prev: declarations, next: "*" },
            { blankLine: "always", prev: "*", next: declarations },
            { blankLine: "always", prev: "*", next: "block-like" },
            { blankLine: "always", prev: "block-like", next: "*" },
            { blankLine: "any", prev: "block-like", next: "block-like" },
            {
                blankLine: "never",
                prev: ["function-overload", exportedOverload],
                next: ["function-overload", "function", exportedOverload, exportedFunction],
            },
            {
                blankLine: "always",
                prev: { selector: "SwitchCase[consequent.length>0]" },
                next: ["case", "default"],
            },
            {
                blankLine: "never",
                prev: { selector: "SwitchCase[consequent.length=0]" },
                next: ["case", "default"],
            },
        ],
        "@stylistic/lines-between-class-members": [
            "error",
            "always",
            { exceptAfterSingleLine: true },
        ],
        "@typescript-eslint/no-this-alias": ["error", { allowedNames: ["runtime"] }],
    },
});
