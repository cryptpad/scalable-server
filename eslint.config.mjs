import globals from "globals";
import pluginJs from "@eslint/js";


export default [
    { files: ["**/*.js"], languageOptions: { sourceType: "commonjs" } },
    { languageOptions: { globals: globals.node } },
    pluginJs.configs.recommended,
    {
        rules: {
            semi: "error",
            indent: ["error", 4],
            "no-useless-escape": "off",
            "no-unused-vars": "warn",
            "no-undef": "warn",
            "no-prototype-builtins": "off",
        }
    },
];
