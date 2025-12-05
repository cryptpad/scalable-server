// SPDX-FileCopyrightText: 2023 XWiki CryptPad Team <contact@cryptpad.org> and contributors
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const fs = require('node:fs');
const Path = require('node:path');
const plugins = {};
const extensions = plugins._extensions = [];
const styles = plugins._styles = [];

try {
    const path = Path.join(__dirname, '..', 'plugins');
    let pluginsDir = fs.readdirSync(path);
    pluginsDir.forEach((name) => {
        if (name=== "README.md") { return; }
        try {
            // NOTE: plugin path relative to the built file.
            // (Plugin not included in the build)
            let plugin = require(`../plugins/${name}/index.js`);
            plugins[plugin.name] = plugin.modules;
            try {
                let hasExt = fs.existsSync(`./plugins/${name}/client/extensions.js`);
                if (hasExt) {
                    extensions.push(plugin.name.toLowerCase());
                }
            } catch (e) {}
            try {
                let hasStyle = fs.existsSync(`./plugins/${name}/client/style.less`);
                if (hasStyle) {
                    styles.push(plugin.name.toLowerCase());
                }
            } catch (e) {}
        } catch (err) {
            console.error(err);
        }
    });
} catch (err) {
    if (err.code !== 'ENOENT') { console.error(err); }
}

plugins.call = command => {
    return function () {
        Object.values(plugins).forEach(plugin => {
            const f = plugin?.[command];
            if (typeof(f) !== "function") { return; }
            f.apply(null, arguments);
        });
    };
};
plugins.get = attr => {
    const result = [];
    Object.values(plugins).forEach(plugin => {
        const v = plugin?.[attr];
        if (typeof(v) !== "undefined") {
            result.push(v);
        }
    });
    return result;
};
plugins.addHttpEndpoints = (Env, app, type) => {
    Object.values(plugins).forEach(plugin => {
        const ep = plugin.httpEndpoints;
        if (!Array.isArray(ep)) { return; }
        ep.forEach(obj => {
            if (obj.type !== type && obj.target !== type) { return; }
            obj.f(Env, app);
        });
    });
};
plugins.getHttpProxy = () => {
    const list = [];
    Object.values(plugins).forEach(plugin => {
        const ep = plugin.httpEndpoints;
        if (!Array.isArray(ep)) { return; }
        ep.forEach(obj => {
            if (obj.type !== 'proxy') { return; }
            list.push(obj);
        });
    });
    return list;
};

module.exports = plugins;
