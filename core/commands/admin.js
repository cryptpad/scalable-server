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

    const decree = [command, args, publicKey, +new Date()];

    // Send to storage:0
    Env.interface.sendQuery('storage:0', 'ADMIN_DECREE', decree, response => {
        cb(response.error, response.data);
    });
};

// addFirstAdmin is an anon_rpc command
Admin.addFirstAdmin = (Env, data, cb) => {
    if (!Env.installToken) { return void cb('EINVAL'); }
    const token = data.token;
    if (!token || !data.edPublic) { return void cb('MISSING_ARGS'); }
    if (token.length !== 64 || data.edPublic.length !== 44) { return void cb('INVALID_ARGS'); }
    if (token !== Env.installToken) { return void cb('FORBIDDEN'); }
    if (Array.isArray(Env.admins) && Env.admins.length) { return void cb('EEXISTS'); }

    const key = data.edPublic;

    Admin.sendDecree(Env, "", ['ADD_FIRST_ADMIN', [
        'ADD_ADMIN_KEY',
        [key]
    ]], (err) => {
        if (err) { return void cb(err); }
        cb();
    });
};

const checkTestDecree = (Env, publicKey, data, cb) => {
    cb(void 0, Env.testDecreeValue);
};

const commands = {
    CHECK_TEST_DECREE: checkTestDecree,
    ADMIN_DECREE: Admin.sendDecree
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
