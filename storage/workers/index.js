// SPDX-FileCopyrightText: 2024 XWiki CryptPad Team <contact@cryptpad.org> and contributors
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const Util = require("../common-util.js");
const { fork } = require("child_process");
const Workers = module.exports;
const PID = process.pid;

const PATH = 'storage/workers/worker.js';
const MAX_JOB = 2;
const DEFAULT_QUERY_TIMEOUT = 60000 * 15;

const Env = {
    Log: {
        error: console.error,
    }
};

Workers.initialize = (Env, conf, _cb) => {
    const cb = Util.once(Util.MkAsync(_cb));

    let incrementTime = (command, start) => {
        if (!command) { return; }
        let end = +new Date();
        let T = Env.commandTimers;
        let diff = (end - start);
        T[command] = (T[command] || 0) + (diff / 1000);
    };

    const workers = [];

    const response = Util.response((errLabel, info) => {
        Env.Log.error('HK_DB_WORKER__' + errLabel, info);
    });

    let isWorker = value =>
        value && value.worker && typeof (value.worker.send) === 'function';

    let guid = () => {
        let id = Util.uid();
        return response.expected(id) ? guid : id;
    };

    // TODO: fix to be actually used
    const countWorkerTasks = () => 0;

    let workerOffset = -1;
    let queue = [];

    let getAvailableWorkerIndex = () => {
        if (queue.length) { return -1; }

        let L = workers.length;
        if (!L) {
            Log.error("NO_WORKERS_AVAILABLE", {
                queue: queue.length,
            });
            return -1;
        }

        workerOffset = (workerOffset + 1) % L;

        let temp;
        for (i = workerOffset; i < workerOffset + L; i++) {
            temp = i % L;
            if (workers[temp] && countWorkerTasks(temp) <= MAX_JOB) {
                return temp;
            }
        }
        return -1;
    };

    let drained = true;
    let sendCommand = (msg, _cb, opt) {
        if (!_cb) {
            return void Env.Log.error('WORKER_COMMAND_MISSING_CB', {
                msg: msg,
                opt: opt,
            });
        }

        opt = opt || {};
        let index = getAvailableWorkerIndex();

        let state = workers[index];
        if (!isWorker(state)) {
            // queue the message for when one becomes available
            queue.push({
                msg: msg,
                cb: _cb,
            });
            if (drained) {
                drained = false;
                Env.Log.error('WORKER_QUEUE_BACKLOG', {
                    workers: workers.length,
                });
            }

            return;
        }

        const txid = guid();
        let start = +new Date();

        let cb = Util.once(Util.mkAsync(Util.both(_cb, function(err /*, value */) {
            incrementTime(msg && msg.command, start);
            if (err !== 'TIMEOUT') { return; }
            Log.debug("WORKER_TIMEOUT_CAUSE", msg);
            // in the event of a timeout the user will receive an error
            // but the state used to resend a query in the event of a worker crash
            // won't be cleared. This also leaks a slot that could be used to keep
            // an upper bound on the amount of parallelism for any given worker.
            // if you run out of slots then the worker locks up.
            delete state.tasks[txid];
        })));

        if (!msg) {
            return void cb('ESERVERERR');
        }

        msg.txid = txid;
        msg.pid = PID;
        // include the relevant worker process id in messages so that it will be logged
        // in the event that the message times out or fails in other ways.
        msg.worker = state.pid;

        // track which worker is doing which jobs
        state.tasks[txid] = msg;

        // default to timing out affter 180s if no explicit timeout is passed
        let timeout = typeof (opt.timeout) !== 'undefined' ? opt.timeout : DEFAULT_QUERY_TIMEOUT;
        response.expect(txid, cb, timeout);

        delete msg._cb;
        delete msg._opt;
        state.worker.send(msg);

        // Add original callback to message data in case we need
        // to resend the command. setTimeout to avoid interfering
        // with worker.send
        setTimeout(function() {
            msg._cb = _cb;
            msg._opt = opt;
        });
    }
};
