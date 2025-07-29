// SPDX-FileCopyrightText: 2023 XWiki CryptPad Team <contact@cryptpad.org> and contributors
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import {nodeResolve} from "@rollup/plugin-node-resolve"
import commonjs from '@rollup/plugin-commonjs';
//import builtins from 'rollup-plugin-node-builtins';
import typescript from '@rollup/plugin-typescript';
import terser from '@rollup/plugin-terser';
import json from '@rollup/plugin-json';

//import nodePolyfills from 'rollup-plugin-polyfill-node';

const getTerser = () => {
    return terser({
        format: {
            comments: 'some',
            beautify: true,
            ecma: '2015',
        },
        compress: false,
        mangle: false,
        module: true,
    });
};
const getPlugins = () => {
    return [
        json(),
        typescript(),
        nodeResolve({
        }),
        commonjs({
            ignore:['config/*.json', 'sodium-native', 'crypto', 'node:http', 'node:https'] // required by tweetnacl for node
        }),
    ];
};

export default [{
    input: "./core/core.ts",
    output: [{
        name: 'cryptpad-server-core',
        file: "./build/core.js",
        format: "cjs",
        plugins: [ getTerser() ]
    }],
    plugins: getPlugins()
}, {
    input: "./websocket/websocket.ts",
    output: [{
        name: 'cryptpad-server-websocket',
        file: "./build/websocket.js",
        format: "cjs",
        plugins: [ getTerser() ]
    }],
    plugins: getPlugins()
}, {
    input: "./storage/storage.ts",
    output: [{
        name: 'cryptpad-server-storage',
        file: "./build/storage.js",
        format: "cjs",
        plugins: [ getTerser() ]
    }],
    plugins: getPlugins()
}];
