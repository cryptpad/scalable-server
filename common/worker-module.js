// SPDX-License-Identifier: AGPL-3.0-or-later
// SPDX-FileCopyrightText: 2025 XWiki CryptPad Team <contact@cryptpad.org> and contributors

const Util = require("./common-util");

const {
  Worker,
  isMainThread,
  parentPort,
  workerData,
} = require('node:worker_threads');

const OS = require("node:os");

const { fork } = require('node:child_process');

const DEFAULT_QUERY_TIMEOUT = 60000 * 15;
const WORKER_TASK_LIMIT = 250000;


/*
- Spawn X workers
- Rotate workers after y tasks
- Be able to send and receive commands to/from the worker
- BONUS: use shared memory with Worker (instead of fork)
*/
const init = workerConfig => {
    const { Log, workerPath,
            maxWorkers, maxJobs,
            commandTimers,
            config, Env } = workerConfig;
    const PID = process.pid;

    const limit = typeof(maxWorkers) === "number" ?
                    maxWorkers : OS.cpus().length;

    const response = Util.response((errLabel, info) => {
        Log.error('WORKER__' + errLabel, info);
    });

    const workers = [];
    let workerOffset = -1;
    const queue = [];
    let drained = true;

    // Utils
    const guid = () => {
        let id = Util.uid();
        return response.expected(id)? guid(): id;
    };
    const isWorker = (state) => {
        return typeof(state?.send) === 'function';
    };
    const incrementTime = (command, start) => {
        if (!command) { return; }
        const end = +new Date();
        const T = commandTimers || {};
        const diff = (end - start);
        T[command] = (T[command] || 0) + (diff / 1000);
    };
    const handleLog = (level, label, info) => {
        if (typeof(Log[level]) !== 'function') { return; }
        Log[level](label, info);
    };

    // Worker definition
    const create = () => {
        return fork(workerPath);
        // return new Worker(...)
    };
    const kill = (worker) => {
        worker.kill();
    };
    const send = (worker, msg) => {
        worker.send(msg);
        //worker.postMessage(...)
    };
    const onMessage = (state, handler) => {
        state?.worker.on('message', res => {
            handler(state, res);
        });
    };


    const countWorkerTasks = (index) => {
        return Object.keys(workers[index]?.tasks || {}).length;
    };
    const getAvailableWorkerIndex = (isQueue) => {
        //  If there is already a backlog of tasks you can avoid
        //  some work by going to the end of the line (unless
        //  we're trying to empty the queue)
        if (queue.length && !isQueue) { return -1; }

        const L = workers.length;
        if (L === 0) {
            Log.warn('NO_WORKERS_AVAILABLE', {
                queue: queue.length,
            });
            return -1;
        }

        // cycle through the workers once
        // start from a different offset each time
        // return -1 if none are available
        workerOffset = (workerOffset + 1) % L;

        let temp;
        for (let i = 0; i < L; i++) {
            temp = (workerOffset + i) % L;
            if (workers[temp] && countWorkerTasks(temp) <= maxJobs) {
                return temp;
            }
        }
        return -1;
    };
    const sendCommand = (msg, _cb, opt = {}, isQueue) => {
        if (!_cb) {
            return void Log.error('WORKER_COMMAND_MISSING_CB', {
                msg: msg,
                opt: opt,
            });
        }
        const index = getAvailableWorkerIndex(isQueue);
        const state = workers[index];

        // no worker available? push to the queue
        if (!isWorker(state)) {
            // queue the message for when one becomes available
            queue.push({
                msg: msg,
                cb: _cb,
            });
            if (drained) {
                drained = false;
                Log.warn('WORKER_QUEUE_BACKLOG', {
                    workers: workers.length,
                });
            }
            return;
        }

        // we have a worker available, send the command
        const txid = guid();
        const start = +new Date();
        const cb = Util.once(Util.mkAsync(Util.both(_cb, err => {
            incrementTime(msg && msg.command, start);
            if (err !== 'TIMEOUT') { return; }
            Log.warn("WORKER_TIMEOUT_CAUSE", msg);
            // In case of timeout, clear the task
            delete state.tasks[txid];
            state.checkTasks();
        })));

        if (!msg) { return void cb('ESERVERERR'); }

        msg.txid = txid;
        msg.pid = PID;
        msg.worker = state.pid; // used for logging

        // Add the task
        state.tasks[txid] = msg;
        const timeout = typeof(opt.timeout) !== 'undefined'? opt.timeout: DEFAULT_QUERY_TIMEOUT;
        response.expect(txid, cb, timeout);

        delete msg._cb; // In case of resend
        delete msg._opt; // In case of resend
        state.send(msg);

        // Add original callback to message data in case we need
        // to resend the command. setTimeout to avoid interfering
        // with worker.send
        setTimeout(function () {
            msg._cb = _cb;
            msg._opt = opt;
        });

        // Check if we need to rotate the worker
        state.count++;
        if (state.count > WORKER_TASK_LIMIT) {
            // Remove from list and spawn new one
            if (state.replaceWorker) { state.replaceWorker(); }
        }
    };
    const handleResponse = (state, res) => {
        if (!res) { return; }
        if (res.log) {
            return void handleLog(res.log, res.label, res.info);
        }

        // handle plugins
        if (res.plugin) {
            // XXX
            return;
        }

        // don't bother handling things addressed to other processes
        if (res.pid !== PID) {
            return void Log.error("WRONG_PID", res);
        }

        if (!res.txid) { return; }
        response.handle(res.txid, [res.error, res.value]);
        delete state.tasks[res.txid];
        state.checkTasks();

        // Task complete, check queue for new task
        if (!queue.length) {
            if (!drained) { drained = true; }
            return;
        }

        const nextMsg = queue.shift();

        if (!nextMsg || !nextMsg.msg) {
            return void Log.error('WORKER_QUEUE_EMPTY_MESSAGE', {
                item: nextMsg,
            });
        }

/*  `nextMsg` was at the top of the queue.
    We know that a job just finished and all of this code
    is synchronous, so calling `sendCommand` should take the worker
    which was just freed up. This is somewhat fragile though, so
    be careful if you want to modify this block. The risk is that
    we take something that was at the top of the queue and push it
    to the back because the following msg took its place. OR, in an
    even worse scenario, we cycle through the queue but don't run anything.
*/
        sendCommand(nextMsg.msg, nextMsg.cb, {}, true);

    };
    // XXX plugin responses

    const initWorker = (worker, cb) => {
        const txid = guid();
        const state = {
            worker,
            tasks: {},
            count: Math.floor(Math.random()*(WORKER_TASK_LIMIT/10)),
            pid: worker.pid,
        };

        const onWorkerClosed = Util.once(() => {
            // XXX plugins
        });

        // Replace the worker on task limit reached. A new one is
        // spawned instantly but we wait for its tasks to be
        // completed before killing it (see checkTasks)
        state.replaceWorker = () => {
            let index = workers.indexOf(state);
            if (index === -1) { return; }
            // Remove old
            workers.splice(index, 1);
            state.replaced = true;
            // Create new
            const w = create();
            Log.info('WORKER_REPLACE_START', {
                from: state.worker.pid,
                to: w.pid
            });
            initWorker(w, (err) => {
                if (err) { throw new Error(err); }
            });
        };

        // If we've reached the limit, kill the worker once
        // all the tasks are complete or timed out
        state.checkTasks = () => {
            // Check if the worker is marked as "replaced"
            if (!state.replaced || !state.worker) { return; }
            // Check remaining tasks
            if (Object.keys(state.tasks).length) { return; }
            // "Replaced" worker without remaining task: kill
            Log.info('WORKER_KILL', {
                worker: state.worker.pid,
                count: state.count
            });
            onWorkerClosed();
            delete state.worker;
            kill(worker);
        };

        // Send a message
        state.send = msg => {
            send(worker, msg);
        };

        // Initialize the worker: send a first message and wait
        // for the response
        response.expect(txid, (err) => {
            if (err) { return void cb(err); }
            workers.push(state);
            cb(void 0, state);
            // We just pushed a new worker, available to receive
            // a task, so we can empty the queue if necessary
            if (queue.length) {
                const nextMsg = queue.shift();
                if (!nextMsg || !nextMsg.msg) {
                    return Log.error('WORKER_QUEUE_EMPTY_MESSAGE', {
                        item: nextMsg,
                    });
                }
                sendCommand(nextMsg.msg, nextMsg.cb, {}, true);
            }
        }, 15000);
        state.send({
            pid: PID,
            txid: txid,
            config: config,
            env: Env
        });

        // Initialize handler
        onMessage(state, handleResponse);

        // On worker error, transfer its tasks and then spawn
        // a new one
        const substituteWorker = Util.once(() => {
            onWorkerClosed();

            Log.info("SUBSTITUTE_DB_WORKER", '');
            let idx = workers.indexOf(state);
            if (idx !== -1) {
                workers.splice(idx, 1);
            }

            Object.keys(state.tasks).forEach((txid) => {
                const cb = response.expectation(txid);
                // If timed out or invalid, ignore
                if (typeof(cb) !== 'function') { return; }
                const task = state.tasks[txid];
                if (!task) { return; }
                response.clear(txid);
                Log.info('DB_WORKER_RESEND', task);
                sendCommand(task, task._cb || cb, task._opt);
            });

            const w = create();
            initWorker(w, (err) => {
                if (err) { throw new Error(err); }
            });
        });

        worker.on('exit', function () {
            if (!state.worker) { return; } // Manually killed
            substituteWorker();
            Log.error("DB_WORKER_EXIT", {
                pid: state.pid,
            });
        });
        worker.on('close', function () {
            if (!state.worker) { return; } // Manually killed
            substituteWorker();
            Log.error("DB_WORKER_CLOSE", {
                pid: state.pid,
            });
        });
        worker.on('error', function (err) {
            if (!state.worker) { return; } // Manually killed
            substituteWorker();
            Log.error("DB_WORKER_ERROR", {
                pid: state.pid,
                error: err,
            });
        });
    };

    for(let i = 0; i < limit; i++) {
        initWorker(create(), function (err) {
            if (!err) { return; }
            return void cb(err);
        });
    }

    return {
        send: (cmd, data, cb, timeout) => {
            let opts;
            if (timeout) {
                opts.timeout = timeout;
            }
            sendCommand({
                command: cmd,
                data
            }, cb, opts);
        }
    };
};

module.exports = init;
