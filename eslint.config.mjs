import js from "@eslint/js";
import globals from "globals";
import { defineConfig } from "eslint/config";


const ignores = ["scripts/**", "build/**", "common/common-util.js"];
export default defineConfig([
  { files: ["**/*.{js,mjs,cjs}"], ignores, plugins: { js }, extends: ["js/recommended"] },
  { files: ["**/*.js"], ignores, languageOptions: { sourceType: "commonjs" } },
  { files: ["**/*.{js,mjs,cjs}"], ignores, languageOptions: { globals: globals.node } },
]);
