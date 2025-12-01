// SPDX-FileCopyrightText: 2023 XWiki CryptPad Team <contact@cryptpad.org> and contributors
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import {nodeResolve} from "@rollup/plugin-node-resolve";
import commonjs from '@rollup/plugin-commonjs';
import typescript from '@rollup/plugin-typescript';
import terser from '@rollup/plugin-terser';
import json from '@rollup/plugin-json';

const type = process.env.TYPE;

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
            ignoreDynamicRequires: true,
            dynamicRequireTargets: ['../plugins/*.js'],
            ignore:['config/*.json', 'sodium-native', 'crypto', 'node:http', 'node:https'] // required by tweetnacl for node
        }),
    ];
};

const list = [];

if (!type || type === "ws") {
    list.push({
        input: "./websocket/websocket.ts",
        output: [{
            name: 'cryptpad-server-websocket',
            file: "./build/websocket.js",
            format: "cjs",
            plugins: [ getTerser() ]
        }],
        plugins: getPlugins()
    });
    list.push({
        input: "./websocket/worker.js",
        output: [{
            name: 'cryptpad-server-websocket-worker',
            file: "./build/ws.worker.js",
            format: "cjs",
            plugins: [ getTerser() ]
        }],
        plugins: getPlugins()
    });
}
if (!type || type === "core") {
    list.push({
        input: "./core/core.ts",
        output: [{
            name: 'cryptpad-server-core',
            file: "./build/core.js",
            format: "cjs",
            plugins: [ getTerser() ]
        }],
        plugins: getPlugins()
    });
    list.push({
        input: "./core/worker.js",
        output: [{
            name: 'cryptpad-server-core-worker',
            file: "./build/core.worker.js",
            format: "cjs",
            plugins: [ getTerser() ]
        }],
        plugins: getPlugins()
    });
}
if (!type || type === "storage") {
    list.push({
        input: "./storage/storage.ts",
        output: [{
            name: 'cryptpad-server-storage',
            file: "./build/storage.js",
            format: "cjs",
            plugins: [ getTerser() ]
        }],
        plugins: getPlugins()
    });
    list.push({
        input: "./storage/worker.js",
        output: [{
            name: 'cryptpad-server-storage-worker',
            file: "./build/storage.worker.js",
            format: "cjs",
            plugins: [ getTerser() ]
        }],
        plugins: getPlugins()
    });
}
if (!type || type === "http") {
    list.push({
        input: "./http-server/http-server.ts",
        output: [{
            name: 'cryptpad-http-server',
            file: "./build/http.js",
            format: "cjs",
            plugins: [ getTerser() ]
        }],
        plugins: getPlugins()
    });
    list.push({
        input: "./http-server/worker.js",
        output: [{
            name: 'cryptpad-http-server-worker',
            file: "./build/http.worker.js",
            format: "cjs",
            plugins: [ getTerser() ]
        }],
        plugins: getPlugins()
    });
}

export default list;
