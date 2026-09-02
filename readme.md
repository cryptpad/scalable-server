<!-- SPDX-FileCopyrightText: 2024 XWiki CryptPad Team <contact@cryptpad.org> and contributors

SPDX-License-Identifier: AGPL-3.0-or-later
-->

This repository contains the code for CryptPad server.

## Architecture

### Taxonomy

The new server architecture is composed of three types of nodes:

- **Core:** these nodes take care of most of the computations and internal
communication handling. They are connected to the other type of servers.
- **Front:** these nodes catch the different queries from the
outside and forward them to the core nodes for processing.
- **Storage:** these nodes are responsible for accessing and serving a fraction
of the (encrypted) data for CryptPad. They are also doing light computation if
they can be done in place without too much pressure on them.

### Topology

The core nodes are connected to both front and storage nodes, but the latter two
cannot communicate directly (only on the same layer).

## Configuration

The configuration can be done in `config/infra.js`, which will store the graph
topology of the nodes and how to connect to them.

Using websockets for communication, please look at `config/infra.example.js` for
explanations.

## Usage

To be used in CryptPad, this repository releases are available on npm:
https://www.npmjs.com/package/cryptpad-server

You can also use it in standalone mode for development purpose. The client code
should be present in `../cryptpad/` or in a `clientRoot` property as a string in
`config/config.js`. Before first use, you may want to install the dependencies
and build the code with:
```bash
npm install
npm run build
```

To spawn the server topology described in `infra/config.js`, run the start script:
```bash
npm run start
```

Alternatively, you can the new servers manually. You first need to start the
`core` nodes with the following command.

For that to work, you need to have a shared key between the different nodes to
authenticate them, which can be generated with:

```bash
openssl rand -base64 32
```

Then add the resulting random bytes in `private.nodes_key` property in your
`config/config.js`.

```bash
node index.js --type core --index 0
```

Then you can start a `front` and `storage` nodes in any order:
```bash
node index.js --type front --index 0
node index.js --type storage --index 0
node index.js --type front --index 1
node index.js --type storage --index 2
node index.js --type storage --index 1
```

Alternatively, you can identify different sets of nodes with the `serverId`
property of their corresponding nodes in `config/infra.js`, and start a subset
of them sharing the same `serverId` with:

```bash
node index.js --server [serverId value]
```

## Tests

The directory [`tests`](tests/) contains some unit and integration tests scripts
and files.

- [`interface.test.js`](tests/interface.test.js): test the communication
interface by implementing a simple ping-pong protocol that computes the time it
takes to go back and forth in the network.

The aforementioned tests can be run with the following command (make sure to
have installed the dependencies with `npm install` beforehand):
```bash
npm run tests
```
