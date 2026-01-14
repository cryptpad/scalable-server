module.exports = {
    "public": {
        // Public URL of the instance (used for Content-Security-Policy)
        origin: "http://localhost:3000",
        // Sandbox URL of the instance
        sandboxOrigin: "http://localhost:3001",
        // Address and port of the nodejs HTTP server
        httpHost: "localhost",
        httpPort: 3000,
        httpSafePort: 3001,
        // (Optional) API server URL if hosted on a different domain (ws and http)
        externalWebsocketURL: undefined,
        fileHost: undefined
    },
    // Configure the topology here. Add or remove nodes on each level
    // depending on your instance usage.
    // "host" and "port" correspond to the nodejs HTTP server of each node
    "websocket": [
        {
            host: "localhost",
            port: 3010,
        },
        {
            host: "localhost",
            port: 3011,
        }
    ],
    "core": [
        {
            host: "localhost",
            port: 3020
        },
        {
            host: "localhost",
            port: 3021
        }
    ],
    "storage": [
        {
            host: "localhost",
            port: 3030
        },
        {
            host: "localhost",
            port: 3031
        }
    ]
};
