// SPDX-FileCopyrightText: 2026 XWiki CryptPad Team <contact@cryptpad.org> and contributors
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const Fs = require('node:fs');
const Path = require('node:path');
const { Worker } = require('node:worker_threads');
const Server = require("../index.js");
process.env.CRYPTPAD_TEST = "server";
const { config, infra } = require("../common/load-config");

Server.start(config, infra)
  .then((serverPids) => new Promise((res, rej) => {
    Fs.readdir(Path.join('.', 'tests'), (_err, dir) => {
      const testPromises = dir.map(file =>
        new Promise((resolve, reject) => {
          if (!/test.js$/.test(file)) { return resolve(); }
          const testWorker = new Worker('./tests/' + file);
          testWorker.on("exit", () => resolve());
          testWorker.on("error", (err) => reject({ err, file }));
        })
      );
      return Promise.all(testPromises).catch(rej).then(() => res(serverPids));
    });
  }))
  .catch((e) => { console.error(`Error in ${e.file}: ${e.err}`); })
  .then((serverPids) => { serverPids.forEach(pid => process.kill(pid)); process.exit(0); });
