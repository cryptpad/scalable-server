const nThen = require("nthen");

const Decrees = {};

Decrees.onNewDecree = (Env, decree, type, cb) => {
    let d = Env.getDecree(type);

    let changed;
    try {
        changed = d.handleCommand(Env, decree) || false;
    } catch (err) {
        return void cb(err.message);
    }

    if (!changed) { return void cb(); }

    let _err;
    nThen((waitFor) => {
        Env.Log.info('DECREE_'+type, JSON.stringify(decree));
        d.write(Env, decree, waitFor((err) => {
            _err = err;
            if (err) {
                waitFor.abort();
                return void cb(err);
            }
            Env.sendDecrees([decree], type, waitFor());
        }));
    }).nThen((waitFor) => {
        // NOTE: 300ms because cache update may take up to 250ms
        setTimeout(waitFor(), 300);
    }).nThen(function () {
        cb(_err);
    });
};

module.exports = Decrees;
