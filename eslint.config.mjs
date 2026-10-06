import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import eslintConfigPrettier from "eslint-config-prettier/flat";
import tseslint from "typescript-eslint";

export default defineConfig({
    files: ["src/**/*.ts"],
    extends: [js.configs.recommended, tseslint.configs.recommended, eslintConfigPrettier],
    rules: {
        curly: ["error", "all"],
        "@typescript-eslint/no-this-alias": ["error", { allowedNames: ["runtime"] }],
    },
});
