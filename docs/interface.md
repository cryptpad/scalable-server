<!-- SPDX-FileCopyrightText: 2024 XWiki CryptPad Team <contact@cryptpad.org> and contributors

SPDX-License-Identifier: AGPL-3.0-or-later
-->
# common/interface.js

This file provides the functions to initialise and create a communication
interface between the different cores composing the server.

This interface can then be implemented using different communication methods,
and should be agnostic from the used method.

## Interface

From `common/interface.js`, only two functions are exposed: `connect` and
`init`. Both provides a `CommunicationManager` object to send and receive
messages.

This works in a client/server fashion where the servers launch `init` to start
listening and update their known clients when they join or leave. Then the
`connect` function starts a client and connects it to the different server
specified in the `Config` variable to let them know that the client is alive.

Thus, the servers (`core` nodes) should start before the clients starts (`ws`
and `storage` nodes).

## CommunicationManager

This manager provides the different nodes with a way to communicate with each
others.

The nodes are identified with an `id` that is formatted as follows:
`type:index`, where the type is in `{ws, core, storage}` specifying the type of
node you are sending a message to.

A manager provides the following functions:
- **`sendEvent(destId, command, args)`**: send a one-way message to `destId`
containing a command and its arguments.
- **`sendQuery(destId, command, args, callback)`**: send a query to `destId`
containing a command and its arguments. Once an answer is received, it is
processed by the callback function with `error` and `data` as its arguments.
- **`handleCommands(commands)`**: from a map `{ command_name: command_handler()
}`, this function populates the handler functions that are called upon receiving
a given command. The handler takes `args` and a `callback` function which
inputs `(err, answer)` are sent back to the sender of the command.
- **`disconnect(handler)`**: not implemented yet.

## Client interface

Internally, the interface manipulates a wrapper around the communication that
should provide the following functions:

- **`send(message)`**: send a (non-serialized) message to the client.
- **`onMessage(handler)`**: add a handler that is called upon receiving
messages.
- **`onDisconnect(handler)`**: add a handler that is called upon disconnecting.
- **`disconnect()`**: close the connection with the client.

## Usage

To create a minimal interface, one can use the following code, assuming you are
one level above the root of the repository:
```javascript
const Interface = require("../common/interface.js");
const WSConnector = require("../common/ws-connector.js");

let Config = {
    infra: {
        core: [{
            host: 'localhost',
            port: 3010
        }],
        ws: [{
            host: 'localhost',
            port: 3012
        }],
        storage: [{
            host: 'localhost',
            port: 3011
        }]
    }
};
```

Now, you can set which node you want to spawn, for instance for a `core` node:
```javascript
Config.myId = 'core:0';
```

Then, start it with `Interface.init` for a `core` node or `Interface.connect`
for a `ws` or `storage` node:
```javascript
let interface = Interface.init(Config, WSConnector);
```

Now you are able to use the `interface` variable to communicate with other
nodes once connected:
```javascript
interface.sendQuery('ws:0', 'HELLO', { whoami: 'core:0' }, function(response) {
    let error = response.error;
    if (error) {
        console.error(`HELLO error: ${error}`)
        return;
    }
    let whois = response.data.whois;
    console.log(`Response obtained from ${whois}`);
});
```
