/* eslint-disable camelcase */
import { expect } from 'chai';
import { MongoLogWriter } from 'mongodb-log-writer';
import setupLoggerAndTelemetry from './setup-logger-and-telemetry';
import { EventEmitter } from 'events';
import { MongoshInvalidInputError } from '@mongosh/errors';
import { MongoshBus } from '@mongosh/types';

describe('setupLoggerAndTelemetry', () => {
  let logOutput: any[];
  let analyticsOutput: ['identify'|'track'|'log', any][];
  let bus: MongoshBus;

  const userId = '53defe995fa47e6c13102d9d';
  const logId = '5fb3c20ee1507e894e5340f3';

  const logger = new MongoLogWriter(logId, `/tmp/${logId}_log`, {
    write(chunk: string, cb: () => void) { logOutput.push(JSON.parse(chunk)); cb(); },
    end(cb: () => void) { cb(); }
  } as any);
  const analytics = {
    identify(info: any) { analyticsOutput.push(['identify', info]); },
    track(info: any) { analyticsOutput.push(['track', info]); }
  };

  beforeEach(() => {
    logOutput = [];
    analyticsOutput = [];
    bus = new EventEmitter();
  });

  it('works', () => {
    setupLoggerAndTelemetry(logId, bus, () => logger, () => analytics);
    expect(logOutput).to.have.lengthOf(1);
    expect(analyticsOutput).to.be.empty;

    bus.emit('mongosh:new-user', userId, false);
    bus.emit('mongosh:new-user', userId, true);

    // Test some events with and without telemetry enabled
    for (const telemetry of [ false, true ]) {
      bus.emit('mongosh:update-user', userId, telemetry);
      bus.emit('mongosh:connect', {
        uri: 'mongodb://localhost/',
        is_localhost: true,
        is_atlas: false,
        node_version: 'v12.19.0'
      } as any);
      bus.emit('mongosh:error', new MongoshInvalidInputError('meow', 'CLIREPL-1005', { cause: 'x' }), 'repl');
      bus.emit('mongosh:use', { db: 'admin' });
      bus.emit('mongosh:show', { method: 'dbs' });
    }

    bus.emit('mongosh:setCtx', { method: 'setCtx' });
    bus.emit('mongosh:api-call', { method: 'auth', class: 'Database', db: 'test-1603986682000', arguments: { } });
    bus.emit('mongosh:api-call', { method: 'redactable', arguments: { filter: { email: 'mongosh@example.com' } } });
    bus.emit('mongosh:evaluate-input', { input: '1+1' });
    bus.emit('mongosh:driver-initialized', { driver: { name: 'nodejs', version: '3.6.1' } });

    const circular: any = {};
    circular.circular = circular;
    bus.emit('mongosh:api-call', { method: 'circulararg', arguments: { options: { circular } } });
    expect(circular.circular).to.equal(circular); // Make sure the argument is still intact afterwards

    bus.emit('mongosh:start-loading-cli-scripts', { usesShellOption: true });
    bus.emit('mongosh:api-load-file', { nested: true, filename: 'foobar.js' });
    bus.emit('mongosh:start-mongosh-repl', { version: '1.0.0' });
    bus.emit('mongosh:api-load-file', { nested: false, filename: 'foobar.js' });
    bus.emit('mongosh:mongoshrc-load');
    bus.emit('mongosh:mongoshrc-mongorc-warn');
    bus.emit('mongosh:eval-cli-script');

    bus.emit('mongosh-snippets:loaded', { installdir: '/' });
    bus.emit('mongosh-snippets:npm-lookup', { existingVersion: 'v1.2.3' });
    bus.emit('mongosh-snippets:npm-lookup-stopped');
    bus.emit('mongosh-snippets:npm-download-failed', { npmMetadataURL: 'https://example.com' });
    bus.emit('mongosh-snippets:npm-download-active', { npmMetadataURL: 'https://example.com', npmTarballURL: 'https://example.net' });
    bus.emit('mongosh-snippets:fetch-index', { refreshMode: 'always' });
    bus.emit('mongosh-snippets:fetch-cache-invalid');
    bus.emit('mongosh-snippets:fetch-index-error', { action: 'fetch', url: 'https://localhost' });
    bus.emit('mongosh-snippets:fetch-index-done');
    bus.emit('mongosh-snippets:package-json-edit-error', { error: 'failed' });
    bus.emit('mongosh-snippets:spawn-child', { args: ['npm', 'install'] });
    bus.emit('mongosh-snippets:load-snippet', { source: 'load-all', name: 'foo' });
    bus.emit('mongosh-snippets:snippet-command', { args: ['install', 'foo'] });
    bus.emit('mongosh-snippets:transform-error', { error: 'failed', addition: 'oh no', name: 'foo' });

    bus.emit('mongosh-sp:connect-heartbeat-failure', { connectionId: 'localhost', failure: new Error('cause'), isFailFast: true, isKnownServer: true });
    bus.emit('mongosh-sp:connect-heartbeat-succeeded', { connectionId: 'localhost' });
    bus.emit('mongosh-sp:connect-fail-early');
    bus.emit('mongosh-sp:connect-attempt-finished');
    bus.emit('mongosh-sp:resolve-srv-error', { from: 'mongodb+srv://foo:bar@hello.world/', error: new Error('failed'), duringLoad: false });
    bus.emit('mongosh-sp:resolve-srv-succeeded', { from: 'mongodb+srv://foo:bar@hello.world/', to: 'mongodb://foo:bar@db.hello.world/' });
    bus.emit('mongosh-sp:reset-connection-options');
    bus.emit('mongosh-sp:missing-optional-dependency', { name: 'kerberos', error: new Error('no kerberos') });

    let i = 0;
    expect(logOutput[i].msg).to.equal('Starting log');
    expect(logOutput[i++].attr).to.include.keys('execPath', 'version', 'distributionKind');
    expect(logOutput[i].msg).to.equal('User updated');
    expect(logOutput[i++].attr).to.deep.equal({ enableTelemetry: false });
    expect(logOutput[i].msg).to.equal('Connecting to server');
    expect(logOutput[i].attr.session_id).to.equal('5fb3c20ee1507e894e5340f3');
    expect(logOutput[i].attr.userId).to.equal('53defe995fa47e6c13102d9d');
    expect(logOutput[i].attr.connectionUri).to.equal('mongodb://localhost/');
    expect(logOutput[i].attr.is_localhost).to.equal(true);
    expect(logOutput[i].attr.is_atlas).to.equal(false);
    expect(logOutput[i++].attr.node_version).to.equal('v12.19.0');
    expect(logOutput[i].s).to.equal('E');
    expect(logOutput[i++].attr.message).to.match(/meow/);
    expect(logOutput[i].msg).to.equal('Used "use" command');
    expect(logOutput[i++].attr).to.deep.equal({ db: 'admin' });
    expect(logOutput[i].msg).to.equal('Used "show" command');
    expect(logOutput[i++].attr).to.deep.equal({ method: 'dbs' });
    expect(logOutput[i].msg).to.equal('User updated');
    expect(logOutput[i++].attr).to.deep.equal({ enableTelemetry: true });
    expect(logOutput[i++].msg).to.equal('Connecting to server');
    expect(logOutput[i].s).to.equal('E');
    expect(logOutput[i++].attr.message).to.match(/meow/);
    expect(logOutput[i].msg).to.equal('Used "use" command');
    expect(logOutput[i++].attr).to.deep.equal({ db: 'admin' });
    expect(logOutput[i].msg).to.equal('Used "show" command');
    expect(logOutput[i++].attr).to.deep.equal({ method: 'dbs' });
    expect(logOutput[i++].msg).to.equal('Initialized context');
    expect(logOutput[i].msg).to.equal('Performed API call');
    expect(logOutput[i++].attr.db).to.equal('test-1603986682000');
    expect(logOutput[i].msg).to.equal('Performed API call');
    expect(logOutput[i++].attr.arguments.filter.email).to.equal('<email>');
    expect(logOutput[i].msg).to.equal('Evaluating input');
    expect(logOutput[i++].attr.input).to.equal('1+1');
    expect(logOutput[i].msg).to.equal('Driver initialized');
    expect(logOutput[i++].attr.driver.version).to.equal('3.6.1');
    expect(logOutput[i].msg).to.equal('Performed API call');
    expect(logOutput[i++].attr._inspected).to.match(/circular/);
    expect(logOutput[i++].msg).to.equal('Start loading CLI scripts');
    expect(logOutput[i].msg).to.equal('Loading file via load()');
    expect(logOutput[i].attr.nested).to.equal(true);
    expect(logOutput[i++].attr.filename).to.equal('foobar.js');
    expect(logOutput[i].msg).to.equal('Started REPL');
    expect(logOutput[i++].attr.version).to.equal('1.0.0');
    expect(logOutput[i].attr.nested).to.equal(false);
    expect(logOutput[i++].attr.filename).to.equal('foobar.js');
    expect(logOutput[i++].msg).to.equal('Loading .mongoshrc.js');
    expect(logOutput[i++].msg).to.equal('Warning about .mongorc.js/.mongoshrc.js mismatch');
    expect(logOutput[i++].msg).to.equal('Evaluating script passed on the command line');
    expect(logOutput[i].msg).to.equal('Loaded snippets');
    expect(logOutput[i++].attr).to.deep.equal({ installdir: '/' });
    expect(logOutput[i].msg).to.equal('Performing npm lookup');
    expect(logOutput[i++].attr).to.deep.equal({ existingVersion: 'v1.2.3' });
    expect(logOutput[i++].msg).to.equal('npm lookup stopped');
    expect(logOutput[i].msg).to.equal('npm download failed');
    expect(logOutput[i++].attr.npmMetadataURL).to.equal('https://example.com');
    expect(logOutput[i].msg).to.equal('npm download active');
    expect(logOutput[i].attr.npmMetadataURL).to.equal('https://example.com');
    expect(logOutput[i++].attr.npmTarballURL).to.equal('https://example.net');
    expect(logOutput[i].msg).to.equal('Fetching snippet index');
    expect(logOutput[i++].attr.refreshMode).to.equal('always');
    expect(logOutput[i++].msg).to.equal('Snippet cache invalid');
    expect(logOutput[i].msg).to.equal('Fetching snippet index failed');
    expect(logOutput[i++].attr).to.deep.equal({ action: 'fetch', url: 'https://localhost' });
    expect(logOutput[i++].msg).to.equal('Fetching snippet index done');
    expect(logOutput[i].msg).to.equal('Modifying snippets package.json failed');
    expect(logOutput[i++].attr).to.deep.equal({ error: 'failed' });
    expect(logOutput[i].msg).to.equal('Spawning helper');
    expect(logOutput[i++].attr).to.deep.equal({ args: ['npm', 'install'] });
    expect(logOutput[i].msg).to.equal('Loading snippet');
    expect(logOutput[i++].attr).to.deep.equal({ source: 'load-all', name: 'foo' });
    expect(logOutput[i].msg).to.equal('Running snippet command');
    expect(logOutput[i++].attr).to.deep.equal({ args: ['install', 'foo'] });
    expect(logOutput[i].msg).to.equal('Rewrote error message');
    expect(logOutput[i++].attr).to.deep.equal({ error: 'failed', addition: 'oh no', name: 'foo' });
    expect(logOutput[i].msg).to.equal('Server heartbeat failure');
    expect(logOutput[i++].attr).to.deep.equal({ connectionId: 'localhost', failure: 'cause', isFailFast: true, isKnownServer: true });
    expect(logOutput[i].msg).to.equal('Server heartbeat succeeded');
    expect(logOutput[i++].attr).to.deep.equal({ connectionId: 'localhost' });
    expect(logOutput[i++].msg).to.equal('Aborting connection attempt as irrecoverable');
    expect(logOutput[i++].msg).to.equal('Connection attempt finished');
    expect(logOutput[i].msg).to.equal('Resolving SRV record failed');
    expect(logOutput[i++].attr).to.deep.equal({ from: 'mongodb+srv://<credentials>@hello.world/', error: 'failed', duringLoad: false });
    expect(logOutput[i].msg).to.equal('Resolving SRV record succeeded');
    expect(logOutput[i++].attr).to.deep.equal({ from: 'mongodb+srv://<credentials>@hello.world/', to: 'mongodb://<credentials>@db.hello.world/' });
    expect(logOutput[i++].msg).to.equal('Reconnect because of changed connection options');
    expect(logOutput[i].msg).to.equal('Missing optional dependency');
    expect(logOutput[i++].attr).to.deep.equal({ name: 'kerberos', error: 'no kerberos' });
    expect(i).to.equal(logOutput.length);

    const mongosh_version = require('../package.json').version;
    expect(analyticsOutput).to.deep.equal([
      [
        'identify',
        {
          userId: '53defe995fa47e6c13102d9d',
          traits: {
            platform: process.platform,
            arch: process.arch
          }
        }
      ],
      [
        'identify',
        {
          userId: '53defe995fa47e6c13102d9d',
          traits: {
            platform: process.platform,
            arch: process.arch
          }
        }
      ],
      [
        'track',
        {
          userId: '53defe995fa47e6c13102d9d',
          event: 'New Connection',
          properties: {
            mongosh_version,
            session_id: '5fb3c20ee1507e894e5340f3',
            is_localhost: true,
            is_atlas: false,
            node_version: 'v12.19.0'
          }
        }
      ],
      [
        'track',
        {
          userId: '53defe995fa47e6c13102d9d',
          event: 'Error',
          properties: {
            mongosh_version,
            name: 'MongoshInvalidInputError',
            code: 'CLIREPL-1005',
            scope: 'CLIREPL',
            metadata: { cause: 'x' }
          }
        }
      ],
      [
        'track',
        {
          userId: '53defe995fa47e6c13102d9d',
          event: 'Use',
          properties: { mongosh_version }
        }
      ],
      [
        'track',
        {
          userId: '53defe995fa47e6c13102d9d',
          event: 'Show',
          properties: {
            mongosh_version,
            method: 'dbs'
          }
        }
      ],
      [
        'track',
        {
          event: 'Script Loaded CLI',
          properties: {
            mongosh_version,
            nested: true,
            shell: true
          },
          userId: '53defe995fa47e6c13102d9d'
        }
      ],
      [
        'track',
        {
          event: 'Script Loaded',
          properties: {
            mongosh_version,
            nested: false
          },
          userId: '53defe995fa47e6c13102d9d'
        }
      ],
      [
        'track',
        {
          event: 'Mongoshrc Loaded',
          properties: {
            mongosh_version,
          },
          userId: '53defe995fa47e6c13102d9d'
        }
      ],
      [
        'track',
        {
          event: 'Mongorc Warning',
          properties: {
            mongosh_version,
          },
          userId: '53defe995fa47e6c13102d9d'
        }
      ],
      [
        'track',
        {
          event: 'Script Evaluated',
          properties: {
            mongosh_version,
            shell: true
          },
          userId: '53defe995fa47e6c13102d9d'
        }
      ],
      [
        'track',
        {
          userId: '53defe995fa47e6c13102d9d',
          event: 'Snippet Install',
          properties: {
            mongosh_version
          }
        }
      ]
    ]);
  });

  it('buffers deprecated API calls', () => {
    setupLoggerAndTelemetry(logId, bus, () => logger, () => analytics);
    expect(logOutput).to.have.lengthOf(1);
    expect(analyticsOutput).to.be.empty;

    const mongosh_version = require('../package.json').version;
    bus.emit('mongosh:new-user', userId, true);

    logOutput = [];
    analyticsOutput = [];

    bus.emit('mongosh:deprecated-api-call', { method: 'cloneDatabase', class: 'Database' });
    bus.emit('mongosh:deprecated-api-call', { method: 'cloneDatabase', class: 'Database' });
    bus.emit('mongosh:deprecated-api-call', { method: 'copyDatabase', class: 'Database' });
    bus.emit('mongosh:deprecated-api-call', { method: 'cloneDatabase', class: 'Database' });

    expect(logOutput).to.be.empty;
    expect(analyticsOutput).to.be.empty;

    bus.emit('mongosh:evaluate-finished');
    expect(logOutput).to.have.length(2);
    expect(analyticsOutput).to.have.length(2);

    expect(logOutput[0].msg).to.equal('Deprecated API call');
    expect(logOutput[0].attr).to.deep.equal({ class: 'Database', method: 'cloneDatabase' });
    expect(logOutput[1].msg).to.equal('Deprecated API call');
    expect(logOutput[1].attr).to.deep.equal({ class: 'Database', method: 'copyDatabase' });
    expect(analyticsOutput).to.deep.equal([
      [
        'track',
        {
          userId: '53defe995fa47e6c13102d9d',
          event: 'Deprecated Method',
          properties: {
            mongosh_version,
            class: 'Database',
            method: 'cloneDatabase',
          }
        }
      ],
      [
        'track',
        {
          userId: '53defe995fa47e6c13102d9d',
          event: 'Deprecated Method',
          properties: {
            mongosh_version,
            class: 'Database',
            method: 'copyDatabase',
          }
        }
      ]
    ]);

    bus.emit('mongosh:new-user', userId, false);
    logOutput = [];
    analyticsOutput = [];

    bus.emit('mongosh:deprecated-api-call', { method: 'cloneDatabase', class: 'Database' });

    expect(logOutput).to.be.empty;
    expect(analyticsOutput).to.be.empty;

    bus.emit('mongosh:evaluate-finished');
    expect(logOutput).to.have.length(1);
    expect(logOutput[0].msg).to.equal('Deprecated API call');
    expect(logOutput[0].attr).to.deep.equal({ class: 'Database', method: 'cloneDatabase' });
    expect(analyticsOutput).to.be.empty;
  });

  it('works when analytics are not available', () => {
    setupLoggerAndTelemetry('5fb3c20ee1507e894e5340f3', bus, () => logger, () => { throw new Error(); });
    bus.emit('mongosh:new-user', userId, true);
    expect(analyticsOutput).to.be.empty;
    expect(logOutput).to.have.lengthOf(2);
    expect(logOutput[1].s).to.equal('E');
  });
});
