<!-- SPDX-FileCopyrightText: 2024 XWiki CryptPad Team <contact@cryptpad.org> and contributors

SPDX-License-Identifier: AGPL-3.0-or-later
-->
# Prototype: Scalable Server for CryptPad

This repository contains a distributed server prototype for CryptPad. This is
still work in progress.

## Architecture

### Taxonomy

The new server architecture is composed of three types of nodes:

- **Core:** these nodes take care of most of the computations and internal
communication handling. They are connected to the other type of servers.
- **Client WebSocket:** these nodes catch the different queries from the
outside and forward them to the core nodes for processing.
- **Storage:** these nodes are responsible for accessing and serving a fraction
of the (encrypted) data for CryptPad. They are also doing light computation if
they can be done in place without too much pressure on them.

### Topology

The core nodes are connected to both ws and storage nodes, but the latter two
cannot communicate directly.

## Configuration

The configuration can be done using the `Config` argument, which will store the
graph topology of the nodes.

Using websockets for communication, this variable looks like this:

```javascript
let Config = {
    infra: {
        ws: [{
            host: 'localhost',
            port: 3010
        }],
        core: [{
            host: 'localhost',
            port: 3011
        }, {
                host: 'localhost',
                port: 3012
            }],
        storage: [{
            host: 'localhost',
            port: 3014
        }]
    }
};
```

The above configuration describes a network comprised of 4 nodes, having one
websocket client node on port `3010`, 2 core servers on port `3011` and `3012`
and a storage node accessible via port `3014`.

In addition, launching a server requires setting the field `myId` with your
identifier, which will be of the form `type:id`. For instance, in the first core
node (the node listening on port `3011`), it would be `Config.myId = 'core:0'`.

## Usage

Before first use, you may want to install the dependencies with:
```bash
npm install
```

To run the new servers, you first need to start the `core` nodes with the command

```bash
node core/index.js
```

Then you can start a `ws` and `storage` nodes in any order:
```bash
node storage/index.js
node websocket/index.js
```

## Tests

The directory [`tests`](tests/) contains some unit and integration tests scripts
and files.

- [`test-interface.js`](tests/test-interface.js): test the communication
interface by implementing a simple ping-pong protocol that computes the time it
takes to go back and forth in the network.
