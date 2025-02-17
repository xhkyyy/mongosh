import { expect } from 'chai';
import sinon, { StubbedInstance, stubInterface } from 'ts-sinon';
import { signatures, toShellResult } from './index';
import ChangeStreamCursor from './change-stream-cursor';
import { ADMIN_DB, ALL_PLATFORMS, ALL_SERVER_VERSIONS, ALL_TOPOLOGIES, ALL_API_VERSIONS } from './enums';
import { ChangeStream, Document } from '@mongosh/service-provider-core';
import { startTestCluster } from '../../../testing/integration-testing-hooks';
import { CliServiceProvider } from '../../service-provider-server/lib';
import ShellInstanceState from './shell-instance-state';
import Mongo from './mongo';
import { ensureMaster, ensureResult } from '../../../testing/helpers';
import Database from './database';
import Collection from './collection';
import { MongoshUnimplementedError } from '@mongosh/errors';
import { EventEmitter } from 'events';

describe('ChangeStreamCursor', () => {
  describe('help', () => {
    const apiClass = new ChangeStreamCursor({} as ChangeStream<Document>, 'source', {} as Mongo);
    it('calls help function', async() => {
      expect((await toShellResult(apiClass.help())).type).to.equal('Help');
      expect((await toShellResult(apiClass.help)).type).to.equal('Help');
    });
  });
  describe('signature', () => {
    it('signature for class correct', () => {
      expect(signatures.ChangeStreamCursor.type).to.equal('ChangeStreamCursor');
    });
    it('next signature', () => {
      expect(signatures.ChangeStreamCursor.attributes.next).to.deep.equal({
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
    let spCursor: StubbedInstance<ChangeStream<Document>>;
    let cursor;
    let warnSpy;
    beforeEach(() => {
      spCursor = stubInterface<ChangeStream<Document>>();
      warnSpy = sinon.spy();

      cursor = new ChangeStreamCursor(spCursor, 'source', {
        _instanceState: { printWarning: warnSpy }
      } as Mongo);
    });

    it('sets dynamic properties', async() => {
      expect((await toShellResult(cursor)).type).to.equal('ChangeStreamCursor');
      const result3 = (await toShellResult(cursor)).printable;
      expect(result3).to.equal('ChangeStreamCursor on source');
      expect((await toShellResult(cursor.help)).type).to.equal('Help');
    });

    it('pretty returns the same cursor', () => {
      expect(cursor.pretty()).to.equal(cursor);
    });

    it('calls spCursor.hasNext with arguments', async() => {
      const result = false;
      spCursor.hasNext.resolves(result);
      const actual = await cursor.hasNext();
      expect(actual).to.equal(result);
      expect(spCursor.hasNext.calledWith()).to.equal(true);
      expect(warnSpy.calledOnce).to.equal(true);
    });
    it('calls spCursor.close with arguments', async() => {
      await cursor.close();
      expect(spCursor.close.calledWith()).to.equal(true);
    });
    it('calls spCursor.tryNext with arguments', async() => {
      const result = { doc: 1 };
      const tryNextSpy = sinon.stub();
      tryNextSpy.resolves(result);
      const cursor2 = new ChangeStreamCursor({
        tryNext: tryNextSpy
      } as any, 'source', {
        _instanceState: { context: { print: warnSpy } }
      } as Mongo);
      const actual = await cursor2.tryNext();
      expect(actual).to.equal(result);
      expect(tryNextSpy.calledWith()).to.equal(true);
    });
    it('calls spCursor.next with arguments', async() => {
      const result = { doc: 1 };
      spCursor.next.resolves(result);
      const actual = await cursor.next();
      expect(actual).to.equal(result);
      expect(spCursor.next.calledWith()).to.equal(true);
      expect(warnSpy.calledOnce).to.equal(true);
    });
  });
  describe('integration', () => {
    const [ srv0 ] = startTestCluster(['--replicaset'] );
    let serviceProvider: CliServiceProvider;
    let instanceState: ShellInstanceState;
    let mongo: Mongo;
    let db: Database;
    let coll: Collection;
    let cursor: ChangeStreamCursor;

    before(async function() {
      this.timeout(100_000);
      serviceProvider = await CliServiceProvider.connect(await srv0.connectionString(), {}, {}, new EventEmitter());
      instanceState = new ShellInstanceState(serviceProvider);
      mongo = new Mongo(instanceState, undefined, undefined, undefined, serviceProvider);
      db = mongo.getDB('testDb');
      coll = db.getCollection('testColl');
    });

    beforeEach(async() => {
      await ensureMaster(mongo.getDB(ADMIN_DB), 1000, await srv0.hostport());
    });

    after(() => {
      return serviceProvider.close(true);
    });

    describe('collection watch', () => {
      beforeEach(async() => {
        cursor = await coll.watch([{ '$match': { 'operationType': 'insert' } }]);
      });
      it('tryNext returns null when there is nothing', async() => {
        const result = await cursor.tryNext();
        expect(result).to.equal(null);
        await cursor.close();
      });
      it('tryNext returns null when there is nothing matching the pipeline', async() => {
        await coll.deleteMany({});
        const result = await cursor.tryNext();
        expect(result).to.equal(null);
      });
      it('tryNext returns document when there is a doc', async() => {
        await coll.insertOne({ myDoc: 1 });
        const result = await ensureResult(
          100,
          async() => await cursor.tryNext(),
          (t) => (t !== null),
          'tryNext to return a document');
        expect(result.operationType).to.equal('insert');
        expect(result.fullDocument.myDoc).to.equal(1);
        await cursor.close();
      });
      it('_it iterates over the cursor', async() => {
        await coll.insertOne({ myDoc: 1 });
        const result = await ensureResult(
          100,
          async() => await cursor._it(),
          (t) => (t.documents.length > 0),
          '_it to return a batch');
        expect(result.documents).to.have.lengthOf(1);
        expect(result.documents[0].operationType).to.equal('insert');
        expect(result.documents[0].fullDocument.myDoc).to.equal(1);
        await cursor.close();
      });
      it('async iteration iterates over the cursor', async() => {
        await coll.insertOne({ myDoc: 1 });
        const result = await ensureResult(
          100,
          async() => {
            for await (const doc of cursor) {
              return doc;
            }
            return null;
          },
          (t) => (t !== null),
          'async iteration to return a batch');
        expect(result.operationType).to.equal('insert');
        expect(result.fullDocument.myDoc).to.equal(1);
        await cursor.close();
      });
      it('isClosed returns whether the cursor is closed', async() => {
        expect(cursor.isClosed()).to.equal(false);
        await cursor.close();
        expect(cursor.isClosed()).to.equal(true);
      });
      it('getResumeToken returns a resumeToken', () => {
        expect(cursor.getResumeToken()).to.be.an('object');
      });
      it('itcount returns batch size', async() => {
        await coll.insertOne({ myDoc: 1 });
        const result = await ensureResult(
          100,
          async() => await cursor.itcount(),
          (t) => t > 0,
          'itcount to return 1');
        expect(result).to.equal(1);
      });
    });
    describe('database watch', () => {
      beforeEach(async() => {
        cursor = await db.watch([{ '$match': { 'operationType': 'insert' } }]);
      });
      it('tryNext returns null when there is nothing', async() => {
        const result = await cursor.tryNext();
        expect(result).to.equal(null);
        await cursor.close();
      });
      it('tryNext returns null when there is nothing matching the pipeline', async() => {
        await coll.deleteMany({});
        const result = await cursor.tryNext();
        expect(result).to.equal(null);
      });
      it('tryNext returns document when there is a doc', async() => {
        await coll.insertOne({ myDoc: 1 });
        const result = await ensureResult(
          100,
          async() => await cursor.tryNext(),
          (t) => (t !== null),
          'tryNext to return a document');
        expect(result.operationType).to.equal('insert');
        expect(result.fullDocument.myDoc).to.equal(1);
        await cursor.close();
      });
      it('itcount returns batch size', async() => {
        await coll.insertOne({ myDoc: 1 });
        const result = await ensureResult(
          100,
          async() => await cursor.itcount(),
          (t) => t > 0,
          'itcount to return 1');
        expect(result).to.equal(1);
      });
      it('can be interrupted when .next() blocks', async() => {
        const nextPromise = cursor.next();
        nextPromise.catch(() => {}); // Suppress UnhandledPromiseRejectionWarning
        await new Promise(resolve => setTimeout(resolve, 100));
        expect(await instanceState.onInterruptExecution()).to.equal(true);
        expect(await instanceState.onResumeExecution()).to.equal(true);
        try {
          await nextPromise;
          expect.fail('missed exception');
        } catch (err) {
          expect(err.name).to.equal('MongoshInterruptedError');
        }
      });
    });
    describe('mongo watch', () => {
      beforeEach(async() => {
        cursor = await mongo.watch([{ '$match': { 'operationType': 'insert' } }]);
      });
      it('tryNext returns null when there is nothing', async() => {
        const result = await cursor.tryNext();
        expect(result).to.equal(null);
        await cursor.close();
      });
      it('tryNext returns null when there is nothing matching the pipeline', async() => {
        await coll.deleteMany({});
        const result = await cursor.tryNext();
        expect(result).to.equal(null);
      });
      it('tryNext returns document when there is a doc', async() => {
        await coll.insertOne({ myDoc: 1 });
        const result = await ensureResult(
          100,
          async() => await cursor.tryNext(),
          (t) => (t !== null),
          'tryNext to return a document');
        expect(result.operationType).to.equal('insert');
        expect(result.fullDocument.myDoc).to.equal(1);
        await cursor.close();
      });
      it('itcount returns batch size', async() => {
        await coll.insertOne({ myDoc: 1 });
        const result = await ensureResult(
          1000,
          async() => await cursor.itcount(),
          (t) => t > 0,
          'itcount to return 1');
        expect(result).to.equal(1);
      });
    });
  });
  describe('unsupported methods', () => {
    let cursor;
    beforeEach(() => {
      cursor = new ChangeStreamCursor({} as ChangeStream<Document>, 'source', {} as Mongo);
    });

    for (const name of ['map', 'forEach', 'toArray', 'objsLeftInBatch']) {
      // eslint-disable-next-line no-loop-func
      it(`${name} fails`, () => {
        expect(() => cursor[name]()).to.throw(MongoshUnimplementedError);
      });
    }
    it('isExhausted fails', async() => {
      try {
        await cursor.isExhausted();
        expect.fail('missed exception');
      } catch (err) {
        expect(err.name).to.equal('MongoshInvalidInputError');
      }
    });
  });
});
