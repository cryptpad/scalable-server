# common/interface.js

This file provides the functions to initialise and create a communication
interface between the different cores composing the server.

This interface can then be implemented using different communication methods,
and should be agnostic from the used method.

## Interface

From `common/interface.js`, only two functions are exposed: `connect` and
`init`. Both provides a `CommunicationManager` object to send and receive
messages.

This works in a client/server fashion where the servers launches `init` to start
listening and update their known clients when they join or leave. Then the
`connect` function starts a client and connect it to the different server
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
a given command. The handlers takes `args` and a `callback` function which
inputs are send back to the sender of the command.
- **`disconnect(handler)`**: not implemented yet.

## Client interface

Internally, the interface manipulates a wrapper around the communication that
should provide the following functions:

- **`send(message)`**: send a (non-serialized) message to the client.
- **`onMessage(handler)`**: add a handler that is called upon receiving
messages.
- **`onDisconnect(handler)`**: add a handler that is called upon disconnecting.
- **`disconnect()`**: close the connection with the client.
