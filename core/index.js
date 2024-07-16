let Env = {};

let getHistory = function () {
    // TODO: Call Storage to get history
}

let onDirectMessage = function(Env, Server, seq, userId, json) {
    const HISTORY_KEEPER_ID = Env.id;

    let parsed;
    try {
        parsed = JSON.parse(json[2]);
    } catch (err) {
        Log.error("HK_PARSE_CLIENT_MESSAGE", json);
        return;
    }

    if (typeof(directMessageCommands[first]) !== 'function') {
        // it's either an unsupported command or an RPC call
        // either way, RPC has it covered
        // return void handleRPC(Env, Server, seq, userId, parsed);
        return;
    }

    let channelName = parsed[1];
    let first = parsed[0];

    if (first === 'GET_HISTORY') {
        getHistory();
    }
}
