const Util = require("../common/common-util");
//const WriteQueue = require("../common/write-queue.js");
const Crypto = require("./crypto.js")('sodiumnative');

const COMMANDS = {};
let Env = {};
// XXX: was in Env before, maybe not needed anymore and can be here?
// XXX: cannot be passed via Env from core/index.js (one instance per worker
// XXX: is needed

const init = (config, cb) => {
    cb();
};

let onValidateMessage = (msg, vk, cb) => {
    let signedMsg;
    try {
        signedMsg = Crypto.decodeBase64(msg);
    } catch (e) {
        return void cb('E_BAD_MESSAGE');
    }

    let validateKey;
    try {
        validateKey = Crypto.decodeBase64(vk);
    } catch (e) {
        return void cb('E_BADKEY');
    }

    const validated = Crypto.sigVerify(signedMsg, validateKey);
    if (!validated) {
        return void cb('FAILED');
    }
    cb();
};


COMMANDS.VALIDATE_MESSAGE = (data, cb) => {
    onValidateMessage(data.signedMsg, data.validateKey, cb);
};




let ready = false;
process.on('message', function(obj) {
    if (!obj || !obj.txid || !obj.pid) {
        return void process.send({
            error: 'E_INVAL',
            data: obj,
        });
    }

    const command = COMMANDS[obj.command];
    const data = obj.data;

    const cb = function(err, value) {
        process.send({
            error: Util.serializeError(err),
            txid: obj.txid,
            pid: obj.pid,
            value: value,
        });
    };

    if (!ready) {
        if (obj.env) {
            Env = Util.tryParse(obj.env);
        }
        return void init(obj.config, function(err) {
            if (err) { return void cb(Util.serializeError(err)); }
            ready = true;
            cb();
        });
    }

    if (typeof (command) !== 'function') {
        return void cb("E_BAD_COMMAND");
    }
    command(data, cb);
});

process.on('uncaughtException', function(err) {
    console.error('[%s] UNCAUGHT EXCEPTION IN DB WORKER', new Date());
    console.error(err);
    console.error("TERMINATING");
    process.exit(1);
});
