const Util = require("../common-util.js");
const { fork } = require("child_process");
const Workers = module.exports;
const PID = process.pid;

const PATH = 'storage/workers/worker.js';
const MAX_JOB=2;
const DEFAULT_QUERY_TIMEOUT = 60000 * 15;

Workers.initialize = (Env, conf, _cb) => {
    const cb = Util.once(Util.MkAsync(_cb));
};
