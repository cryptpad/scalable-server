module.exports = {
    "public": {
        "origin": "http://localhost:3000",
        "sandboxOrigin": "http://localhost:3001",
        "httpPort": 3000,
        "httpSafePort": 3001,
        "httpHost": "localhost",
        "externalWebsocketURL": undefined,
        "fileHost": undefined
    },
    // XXX we have to add "href" and "websocketHref" to the following values
    // if we want to reach a node located on another machine
    // This will need to be configured in the proxy (http.worker) and in the
    // connector (ws-connector / initClient)
    "websocket": [
        {
            "host": "localhost",
            "port": 3010,
            "websocketPort": 3005,
            "websocketHost": "::"
        },
        {
            "host": "localhost",
            "port": 3011,
            "websocketPort": 3006,
            "websocketHost": "::"
        }
    ],
    "core": [
        {
            "host": "localhost",
            "port": 3020
        },
        {
            "host": "localhost",
            "port": 3021
        }
    ],
    "storage": [
        {
            "host": "localhost",
            "port": 3030
        },
        {
            "host": "localhost",
            "port": 3031
        }
    ]
};
