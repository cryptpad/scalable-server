// SPDX-FileCopyrightText: 2026 XWiki CryptPad Team <contact@cryptpad.org> and contributors
//
// SPDX-License-Identifier: AGPL-3.0-or-later

const Fs = require('node:fs');
const Path = require('node:path');
const { Worker } = require('node:worker_threads');
const Server = require("../index.js");
const { config, infra } = require("../common/load-config")(true);

Server.start(config, infra)
  .catch((e) => {
    console.error('Fail to start the test server: ', e);
    process.exit(1);
  })
  .then(() => {
    const testsPath = Path.join('.', 'tests');
    try {
      const dir = Fs.readdirSync(testsPath);

      const testPromises = dir.map(file =>
        new Promise((resolve, reject) => {
          if (!/test.js$/.test(file)) { return resolve(); }
          try {
            const testWorker = new Worker('./tests/' + file);
            testWorker.on("exit", (exitCode) => exitCode && reject({ err: 'Test failed', file }) || resolve());
            testWorker.on("error", (err) => reject({ err, file }));
          } catch (err) {
            reject({ err, file });
          }
        })
      );
      return Promise.all(testPromises);
    }
    catch (err) {
      Promise.reject({ err, file: testsPath });
    }
  })
  .catch((e) => { console.error(`Error in ${e.file}: ${e.err}`); })
  .finally(() => {
    // Stop the test server
    process.exit(0);
  });
