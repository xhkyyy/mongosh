import { expect } from 'chai';
import Session from './session';
import { ServiceProvider, ClientSession as ServiceProviderSession, bson } from '@mongosh/service-provider-core';
import { StubbedInstance, stubInterface } from 'ts-sinon';
import ShellInstanceState from './shell-instance-state';
import { signatures, toShellResult } from './index';
import Mongo from './mongo';
import {
  ADMIN_DB,
  ALL_PLATFORMS,
  ALL_API_VERSIONS,
  ALL_SERVER_VERSIONS,
  ALL_TOPOLOGIES
} from './enums';
import { CliServiceProvider } from '../../service-provider-server';
import { startTestCluster, skipIfApiStrict } from '../../../testing/integration-testing-hooks';
import { ensureMaster, ensureSessionExists } from '../../../testing/helpers';
import Database from './database';
import { CommonErrors, MongoshInvalidInputError } from '@mongosh/errors';
import { EventEmitter } from 'events';

describe('Session', () => {
  describe('help', () => {
    const apiClass = new Session({} as Mongo, {}, {} as ServiceProviderSession);
    it('calls help function', async() => {
      expect((await toShellResult(apiClass.help())).type).to.equal('Help');
      expect((await toShellResult(apiClass.help)).type).to.equal('Help');
    });
  });
  describe('signature', () => {
    it('signature for class correct', () => {
      expect(signatures.Session.type).to.equal('Session');
    });
    it('map signature', () => {
      expect(signatures.Session.attributes.endSession).to.deep.equal({
        type: 'function',
        returnsPromise: true,
        deprecated: false,
        returnType: { type: 'unknown', attributes: {} },
        platforms: ALL_PLATFORMS,
        topologies: ALL_TOPOLOGIES,
        apiVersions: ALL_API_VERSIONS,
        serverVersions: ALL_SERVER_VERSIONS,
        isDirectShellCommand: false,
        shellCommandCompleter: undefined
      });
    });
  });
  describe('instance', () => {
    let serviceProviderSession: StubbedInstance<ServiceProviderSession>;
    let mongo: Mongo;
    let options;
    let session: Session;
    let instanceState: ShellInstanceState;
    let serviceProvider: StubbedInstance<ServiceProvider>;
    beforeEach(() => {
      options = {
        causalConsistency: false,
        readConcern: { level: 'majority' },
        writeConcern: { w: 1, j: false, wtimeout: 0 },
        readPreference: { mode: 'primary', tagSet: [] }
      };
      serviceProviderSession = stubInterface<ServiceProviderSession>();
      (serviceProviderSession as any).id = { id: 1 };
      serviceProvider = stubInterface<ServiceProvider>();
      serviceProvider.initialDb = 'test';
      serviceProvider.bsonLibrary = bson;
      instanceState = new ShellInstanceState(serviceProvider, new EventEmitter());
      mongo = new Mongo(instanceState, undefined, undefined, undefined, serviceProvider);
      session = new Session(mongo, options, serviceProviderSession);
    });

    it('sets dynamic properties', async() => {
      expect((await toShellResult(session)).type).to.equal('Session');
      expect((await toShellResult(session)).printable).to.deep.equal(serviceProviderSession.id);
      expect((await toShellResult(session.help)).type).to.equal('Help');
    });
    describe('getDatabase', () => {
      it('works for a regular database', () => {
        const db = session.getDatabase('test');
        expect(db).to.deep.equal(new Database(mongo, 'test', session));
        expect(session.getDatabase('test')).to.equal(db); // reuses db
      });
      it('also affects Database.getSiblingDB', () => {
        const db = session.getDatabase('othername').getSiblingDB('test');
        expect(db).to.deep.equal(new Database(mongo, 'test', session));
        expect(session.getDatabase('test')).to.equal(db); // reuses db
      });
      it('throws for an invalid name', () => {
        try {
          session.getDatabase('');
          expect.fail('expected error');
        } catch (e) {
          expect(e).to.be.instanceOf(MongoshInvalidInputError);
          expect(e.code).to.equal(CommonErrors.InvalidArgument);
        }
      });
    });
    it('advanceOperationTime', () => {
      const ts = { ts: 1 } as any;
      session.advanceOperationTime(ts);
      expect(serviceProviderSession.advanceOperationTime).to.have.been.calledOnceWith(ts);
    });
    it('advanceClusterTime', () => {
      const ct = { clusterTime: { ts: 1 } } as any;
      session.advanceClusterTime(ct);
      expect(serviceProviderSession.advanceClusterTime).to.have.been.calledOnceWith(ct);
    });
    it('endSession', async() => {
      await session.endSession();
      expect(serviceProviderSession.endSession).to.have.been.calledOnceWith();
    });
    it('getClusterTime', () => {
      (serviceProviderSession as any).clusterTime = 100 as any;
      expect(session.getClusterTime()).to.equal(100);
    });
    it('getOperationTime', () => {
      (serviceProviderSession as any).operationTime = 200 as any;
      expect(session.getOperationTime()).to.equal(200);
    });
    it('hasEnded', () => {
      serviceProviderSession.hasEnded = 100 as any; // mystery: testing with false makes this error bc of the spy
      expect(session.hasEnded()).to.equal(100);
    });
    it('startTransaction', () => {
      serviceProviderSession.startTransaction.returns();
      session.startTransaction({ readPreference: options.readPreference });
      expect(serviceProviderSession.startTransaction).to.have.been.calledOnceWith({ readPreference: options.readPreference });
    });
    it('commitTransaction', async() => {
      serviceProviderSession.commitTransaction.resolves();
      await session.commitTransaction();
      expect(serviceProviderSession.commitTransaction).to.have.been.calledOnceWith();
    });
    it('abortTransaction', async() => {
      serviceProviderSession.abortTransaction.resolves();
      await session.abortTransaction();
      expect(serviceProviderSession.abortTransaction).to.have.been.calledOnceWith();
    });
  });
  describe('integration', () => {
    const [ srv0 ] = startTestCluster(['--replicaset']);
    let serviceProvider: CliServiceProvider;
    let instanceState: ShellInstanceState;
    let mongo: Mongo;
    let session: Session;
    let databaseName: string;

    before(function() {
      if (process.platform === 'win32') {
        return this.skip();
      }

      this.timeout(100_000);
    });

    beforeEach(async() => {
      databaseName = `test-${Date.now()}`;
      serviceProvider = await CliServiceProvider.connect(await srv0.connectionString(), {}, {}, new EventEmitter());
      instanceState = new ShellInstanceState(serviceProvider);
      mongo = new Mongo(instanceState, undefined, undefined, undefined, serviceProvider);
      await ensureMaster(mongo.getDB(ADMIN_DB), 1000, await srv0.hostport());
    });

    afterEach(async() => {
      if (session) {
        await session.endSession();
      }

      if (serviceProvider) {
        await serviceProvider.close(true);
      }
    });

    describe('server starts and stops sessions', () => {
      skipIfApiStrict(); // ensureSessionExists needs $listLocalSessions
      it('starts a session', async() => {
        session = mongo.startSession();
        await session.getDatabase(databaseName).getCollection('coll').insertOne({});
        await ensureSessionExists(mongo, 1000, JSON.stringify(session.id.id));
        expect(session.hasEnded()).to.be.false;
        await session.endSession();
        expect(session.hasEnded()).to.be.true;
        try {
          await session.getDatabase(databaseName).getCollection('coll').insertOne({});
        } catch (e) {
          return expect(e.message).to.include('expired sessions');
        }
        expect.fail('Error not thrown');
      });
      it('handles multiple sessions', async() => {
        const sessions = [
          mongo.startSession(),
          mongo.startSession(),
          mongo.startSession()
        ];
        for (const s of sessions) {
          await s.getDatabase(databaseName).getCollection('coll').insertOne({});
          expect(s.hasEnded()).to.be.false;
          await ensureSessionExists(mongo, 1000, JSON.stringify(s.id.id));
        }
        for (const s of sessions) {
          await s.endSession();
          expect(s.hasEnded()).to.be.true;
          try {
            await s.getDatabase(databaseName).getCollection('coll').insertOne({});
          } catch (e) {
            expect(e.message).to.include('expired sessions');
            continue;
          }
          expect.fail('Error not thrown');
        }
      });
      it('errors if session expired', async() => {
        session = mongo.startSession();
        await session.endSession();
        try {
          await session.getDatabase(databaseName).getCollection('coll').insertOne({});
        } catch (e) {
          return expect(e.message).to.include('expired');
        }
        expect.fail('Error not thrown');
      });
    });
    describe('transaction methods are called', () => {
      it('cannot call start transaction twice', () => {
        session = mongo.startSession();
        session.startTransaction();
        try {
          session.startTransaction();
        } catch (e) {
          return expect(e.message).to.include('in progress');
        }
        expect.fail('Error not thrown');
      });
      it('cannot abort when not started', async() => {
        session = mongo.startSession();
        try {
          await session.abortTransaction();
        } catch (e) {
          return expect(e.message).to.include('transaction started');
        }
        expect.fail('Error not thrown');
      });
      it('cannot commit when not started', async() => {
        session = mongo.startSession();
        try {
          await session.commitTransaction();
        } catch (e) {
          return expect(e.message).to.include('transaction started');
        }
        expect.fail('Error not thrown');
      });
      it('commits a transaction', async() => {
        const doc = { value: 'test', count: 0 };
        const testColl = mongo.getDB(databaseName).getCollection('coll');
        await testColl.drop();
        await testColl.insertOne(doc);
        expect((await testColl.findOne({ value: 'test' })).count).to.equal(0);
        session = mongo.startSession();
        session.startTransaction();
        const sessionColl = session.getDatabase(databaseName).getCollection('coll');
        expect((await sessionColl.updateOne(
          { value: 'test' },
          { $inc: { count: 1 } }
        )).acknowledged).to.be.true;
        expect((await testColl.findOne({ value: 'test' })).count).to.equal(0);
        await session.commitTransaction();
        expect((await testColl.findOne({ value: 'test' })).count).to.equal(1);
      });
      it('aborts a transaction', async() => {
        const doc = { value: 'test', count: 0 };
        const testColl = mongo.getDB(databaseName).getCollection('coll');
        await testColl.drop();
        await testColl.insertOne(doc);
        expect((await testColl.findOne({ value: 'test' })).count).to.equal(0);
        session = mongo.startSession();
        session.startTransaction();
        const sessionColl = session.getDatabase(databaseName).getCollection('coll');
        expect((await sessionColl.updateOne(
          { value: 'test' },
          { $inc: { count: 1 } }
        )).acknowledged).to.be.true;
        expect((await testColl.findOne({ value: 'test' })).count).to.equal(0);
        await session.abortTransaction();
        expect((await testColl.findOne({ value: 'test' })).count).to.equal(0);
      });
    });
    describe('after resetting connection will error with expired session', () => {
      skipIfApiStrict();
      it('reset connection options', async() => {
        session = mongo.startSession();
        await mongo.setReadConcern('majority');
        try {
          await session.getDatabase(databaseName).getCollection('coll').insertOne({});
        } catch (e) {
          return expect(e.message).to.include('expired');
        }
      });
      it('authentication', async() => {
        await mongo.getDB(databaseName).createUser({ user: 'anna', pwd: 'pwd', roles: [] });
        session = mongo.startSession();
        await mongo.getDB(databaseName).auth('anna', 'pwd');
        try {
          await session.getDatabase(databaseName).getCollection('coll').insertOne({});
        } catch (e) {
          await mongo.getDB(databaseName).logout();
          return expect(e.message).to.include('expired');
        }
      });
    });
  });
});

