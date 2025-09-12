const nThen = require("nthen");

const Decrees = {};

Decrees.onNewDecree = (Env, decree, cb) => {
    let changed;
    try {
        changed = Env.adminDecrees.handleCommand(Env, decree) || false;
    } catch (err) {
        return void cb(err.message);
    }

    if (!changed) { return void cb(); }

    let _err;
    nThen((waitFor) => {
        Env.Log.info('ADMIN_DECREE', JSON.stringify(decree));
        Env.adminDecrees.write(Env, decree, waitFor((err) => {
            _err = err;
            if (err) {
                waitFor.abort();
                return void cb(err);
            }
            Env.sendDecrees([decree], waitFor());
        }));
    }).nThen((waitFor) => {
        // NOTE: 300ms because cache update may take up to 250ms
        setTimeout(waitFor(), 300);
    }).nThen(function () {
        cb(_err);
    });
};

module.exports = Decrees;
