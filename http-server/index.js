const Logger = require("../common/logger.js");
const Environment = require('../common/env.js');
const nThen = require('nthen');
const WorkerModule = require("../common/worker-module.js");
const Cluster = require("node:cluster");

const Interface = require("../common/interface.js");
const WSConnector = require("../common/ws-connector.js");

const onNewDecrees = (Env, args, cb) => {
    const { type, decrees } = args;
    Env.cacheDecrees(type, decrees);
    Env.getDecree(type).loadRemote(Env, decrees);
    Env.workers.broadcast('NEW_DECREES', {
        type, decrees
    }, () => {
        Env.Log.verbose('UPDATE_DECREE_WS_WORKER');
    });
    cb();
};

const initHttpCluster = (Env, mainConfig) => {
    return new Promise((resolve) => {
        Cluster.setupPrimary({
            exec: './build/http.worker.js',
            args: [],
        });

        const WORKERS = 2;
        const workerConfig = {
            Log: Env.Log,
            noTaskLimit: true,
            customFork: () => {
                return Cluster.fork({});
            },
            maxWorkers: WORKERS, // XXX
            maxJobs: 10,
            commandTimers: {}, // time spent on each command
            config: mainConfig,
            Env: { // Serialized Env (Environment.serialize)
            }
        };

        let ready = 0;
        Cluster.on('online', () => {
            ready++;
            if (ready === WORKERS) {
                resolve();
            }
        });

        Env.workers = WorkerModule(workerConfig);
        Env.workers.onNewWorker(state => {
            Object.keys(Env.allDecrees).forEach(type => {
                const decrees = Env.allDecrees[type];
                Env.workers.sendTo(state, 'NEW_DECREES', {
                    decrees, type
                }, () => {
                    Env.Log.verbose('UPDATE_DECREE_HTTP_WORKER');
                });
            });
        });
    });
};

const start = (mainConfig) => {
    const { config, infra } = mainConfig;
    const index = 0;
    const myId = 'http:0';
    const Env = {
        Log: Logger(config, myId)
    };

    Environment.init(Env, mainConfig);

    const callWithEnv = f => {
        return function () {
            [].unshift.call(arguments, Env);
            return f.apply(null, arguments);
        };
    };
    const CORE_COMMANDS = {
        NEW_DECREES: callWithEnv(onNewDecrees)
    };

    nThen(w => {
        initHttpCluster(Env, mainConfig).then(w());
    }).nThen(w => {
        const interfaceConfig = {
            connector: WSConnector,
            index, infra, myId,
            server: config,
            Log: Env.Log
        };
        Env.interface = Interface.init(interfaceConfig, w(err => {
            if (err) {
                w.abort();
                Env.Log.error('INIT_INTERFACE_ERROR', interfaceConfig.myId, ' error:', err);
                return;
            }
        }));
        Env.interface.handleCommands(CORE_COMMANDS);
    }).nThen(() => {
        if (!process.send) { return; }
        process.send({
            type: 'http',
            index: 0,
            dev: Env.DEV_MODE,
            msg: 'READY'
        });
    });
};

module.exports = {
    start
};

