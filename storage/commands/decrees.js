const nThen = require("nthen");

const Decrees = {};

Decrees.onNewDecree = (Env, decree, cb) => {
    let changed;
    try {
        changed = AdminDecrees.handleCommand(Env, decree) || false;
    } catch (err) {
        return void cb(err);
    }

    if (!changed) { return void cb(); }

    Env.sendDecrees([decree]);

    Env.Log.info('ADMIN_DECREE', decree);
    let _err;
    nThen((waitFor) => {
        Decrees.write(Env, decree, waitFor((err) => {
            _err = err;
        }));
        // NOTE: 300ms because cache update may take up to 250ms
        setTimeout(waitFor(), 300);
    }).nThen(function () {
        cb(_err);
    });
};

module.exports = Decrees;
