// SPDX-FileCopyrightText: 2025 XWiki CryptPad Team <contact@cryptpad.org> and contributors
//
// SPDX-License-Identifier: AGPL-3.0-or-later
const { fork } = require('child_process');
const Crypto = require('crypto');
const Path = require('node:path');

const showHelp = () => {
    console.log(`Usage ${process.argv[1]}:`);
    console.log("\t--help, -h\tDisplay this help");
    console.log("\t--type,-t\tSet the node type (if unset, starts every node)");
    console.log("\t--index,-i\tSet the node index (default: 0)");
    process.exit(1);
};

const args = process.argv.slice(2);
const cliArgs = {};
let prev;
args.some(arg => {
    if (arg === '--type' || arg === '-t') {
        if (prev) { throw new Error('INVALID ARGS');}
        prev = 'type';
        return;
    }
    if (arg === '--index' || arg === '-i') {
        if (prev) { throw new Error('INVALID ARGS');}
        prev = 'index';
        return;
    }
    if (arg === '--server' || arg === '-s') {
        if (prev) { throw new Error('INVALID ARGS');}
        prev = 'server';
        return;
    }
    if (arg === '--help' || arg === '-h') {
        showHelp();
        return true;
    }
    if (/^--?/.test(arg)) {
        prev = '';
        return;
    }

    if (!prev) { return; }
    cliArgs[prev] = arg;
    prev = '';
});

const start = (serverConfig, infraConfig) => {
    const Log = {
        debug: console.debug,
        error: console.error,
        info: console.log,
        verbose: console.info,
        warn: console.warn
    };

    let serverId;
    const startNode = (type, index, forking, cb) => {
        if (typeof (cb) !== 'function') { cb = () => { }; };

        const nodeFile = './build/' + type + '.js';
        const path = Path.join(__dirname, nodeFile);
        const initConfig = {
            myId: `${type}:${index}`,
            index,
            config: serverConfig,
            infra: infraConfig
        };

        //Log.info(`Starting: ${initConfig.myId}`);
        if (forking) {
            let nodeProcess = fork(path);
            nodeProcess.send(initConfig);
            nodeProcess.on('message', (message) => {
                if (message.msg === 'READY') {
                    Log.info(`Started: ${type}:${message.index}`);
                    if (message.dev) {
                        Log.info('DEV mode enabled');
                    }
                    cb();
                }
            });
            // FIXME
            nodeProcess.on('error', (err) => {
                Log.error('Child process stopped due to error.');
                Log.error(err);
                process.exit(1);
            });
            nodeProcess.on('exit', (err) => {
                Log.error('Child process stopped due to error.');
                Log.error(err);
                process.exit(1);
            });
        } else {
            require(path).start(initConfig);
        }
    };

    const coresReady = () => {
        const promises = [];
        infraConfig?.front?.forEach((data, index) => {
            promises.push(new Promise(resolve => {
                if (serverId && data.serverId !== serverId) { return resolve(); }
                startNode('front', index, true, resolve);
            }));
        });
        infraConfig?.storage?.forEach((data, index) => {
            promises.push(new Promise(resolve => {
                if (serverId && data.serverId !== serverId) { return resolve(); }
                startNode('storage', index, true, resolve);
            }));
        });
        promises.push(new Promise(resolve => {
            if (serverId && infraConfig?.public?.httpServerId !== serverId) { return resolve(); }
            startNode('http', 0, true, resolve);
        }));
        Promise.all(promises).then(() => {
            Log.info('CryptPad server ready');
        });
    };

    const startCores = () => {
        if (!serverConfig?.private?.nodes_key) {
            if (!serverConfig?.private) {
                serverConfig.private = { };
            }
            serverConfig.private.nodes_key = Crypto.randomBytes(32).toString('base64');
        }
        const corePromises = infraConfig?.core.map((data, index) => new Promise((resolve, reject) => {
            // hosted on another machine?
            if (serverId && data.serverId !== serverId) { return resolve(); }
            startNode('core', index, true, (err) => {
                if (err) {
                    Log.error('START_CORE_ERROR', err);
                    return reject(err);
                }
                return resolve();
            });
        }));

        Promise.all(corePromises)
            .then(() => { coresReady(); })
            .catch((e) => { return Log.error('START_CORE_ERROR', e); });
    };


    // Start process
    if (cliArgs.type) {
        const type = cliArgs.type;
        const index = Number(cliArgs.index || 0);
        if (!serverConfig?.private?.nodes_key) {
            throw Error('E_MISSINGKEY');
        }
        startNode(type, index, false, (err) => {
            if (err) { return Log.error('START_NODE_ERROR', err); }
        });
    } else {
        serverId = cliArgs.server;
        startCores();
    }
};

if (require.main === module) {
    const { config, infra } = require('./common/load-config');
    start(config, infra);
} else {
    module.exports = { start };
}
