import globals from "globals";
import { defineConfig } from "eslint/config";


const ignores = ["scripts/**", "build/**", "common/common-util.js"];
export default defineConfig([
  {
    files: ["**/*.{js,mjs,cjs}"],
    ignores,
    languageOptions: { globals: globals.node },
    rules: {
        indent: ["off", 4],
        "linebreak-style": ["off", "unix"],
        quotes: ["off", "single"],
        semi: ["error", "always"],
        eqeqeq: ["error", "always"],
        "no-irregular-whitespace": ["off"],
        "no-self-assign": ["off"],
        "no-empty": ["off"],
        "no-useless-escape": ["off"],
        "no-extra-boolean-cast": ["off"],
        "no-prototype-builtins": ["error"],
        "no-use-before-define": ["error"],
        "no-undef": ["error"],
        "no-unused-vars": [
            "error",
            {
                caughtErrors: "none"
            }
        ]
    }
  }
]);
