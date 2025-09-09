const Util = require('../../common/common-util.js');

const Admin = {};

// CryptPad_AsyncStore.rpc.send('ADMIN', [ 'ADMIN_DECREE', ['RESTRICT_REGISTRATION', [true]]], console.log)
Admin.sendDecree = (Env, publicKey, data, cb) => {
    const value = data[1];
    if (!Array.isArray(value)) { return void cb('INVALID_DECREE'); }

    const command = value[0];
    const args = value[1];

/*

The admin should have sent a command to be run:

the server adds two pieces of information to the supplied decree:

* the unsafeKey of the admin who uploaded it
* the current time

1. test the command to see if it's valid and will result in a change
2. if so, apply it and write it to the log for persistence
3. respond to the admin with an error or nothing

*/

    const decree = [command, args, unsafeKey, +new Date()];

    // Send to storage:0

    let changed;
    try {
        changed = Decrees.handleCommand(Env, decree) || false;
    } catch (err) {
        return void cb(err);
    }

    if (!changed) { return void cb(); }
    Env.Log.info('ADMIN_DECREE', decree);
    let _err;
    nThen((waitFor) => {
        Decrees.write(Env, decree, waitFor((err) => {
            _err = err;
        }));
        setTimeout(waitFor(), 300); // NOTE: 300 because cache update may take up to 250ms
    }).nThen(function () {
        cb(_err);
    });
};

const commands = {
    ADMIN_DECREE: adminDecree
};

Admin.command = (Env, safeKey, data, _cb) => {
    const cb = Util.once(Util.mkAsync(_cb));

    const admins = Env.admins;
    const unsafeKey = Util.unescapeKeyCharacters(safeKey);

    if (admins.indexOf(unsafeKey) === -1) {
        return void cb("FORBIDDEN");
    }

    const command = commands[data[0]];

    /*
    // XXX plugins
    Object.keys(Env.plugins || {}).forEach(name => {
        let plugin = Env.plugins[name];
        if (!plugin.addAdminCommands) { return; }
        try {
            let c = plugin.addAdminCommands(Env);
            Object.keys(c || {}).forEach(cmd => {
                if (typeof(c[cmd]) !== "function") { return; }
                if (commands[cmd]) { return; }
                commands[cmd] = c[cmd];
            });
        } catch (e) {}
    });
    */

    if (typeof(command) === 'function') {
        return void command(Env, unsafeKey, data, cb);
    }

    return void cb('UNHANDLED_ADMIN_COMMAND');


};

module.exports = Admin;
