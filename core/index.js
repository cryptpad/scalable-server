let Env = {};

let getHistory = function (Env, Server, seq, userId, parsed) {
    // TODO: Call Storage to get history
}

let onDirectMessage = function(Env, Server, seq, userId, json) {
    const HISTORY_KEEPER_ID = Env.id;

    let parsed;
    try {
        parsed = JSON.parse(json[2]);
    } catch (err) {
        // TODO: Send ACK error
        console.error("HK_PARSE_CLIENT_MESSAGE", json);
        return;
    }

    // TODO: Send ACK to user
    let first = parsed[0];

    if (first === 'GET_HISTORY') {
        getHistory(Env, Server, seq, userId, parsed);
    }
}
