import { expect } from 'chai';
import sinon from 'ts-sinon';
import { ALL_PLATFORMS, ALL_SERVER_VERSIONS, ALL_TOPOLOGIES, ALL_API_VERSIONS, ServerVersions } from './enums';
import { signatures, toShellResult } from './index';
import ExplainableCursor from './explainable-cursor';

describe('ExplainableCursor', () => {
  describe('help', () => {
    const apiClass = new ExplainableCursor({} as any, {} as any, 'queryPlannerExtended');
    it('calls help function', async() => {
      expect((await toShellResult(apiClass.help())).type).to.equal('Help');
      expect((await toShellResult(apiClass.help)).type).to.equal('Help');
    });
  });
  describe('signature', () => {
    it('signature for class correct', () => {
      expect(signatures.ExplainableCursor.type).to.equal('ExplainableCursor');
    });
    it('inherited (map) signature', () => {
      expect(signatures.ExplainableCursor.attributes.map).to.deep.equal({
        type: 'function',
        returnsPromise: false,
        deprecated: false,
        returnType: 'ExplainableCursor',
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
    let wrappee: any;
    let eCursor;
    beforeEach(() => {
      wrappee = {
        map: sinon.spy(),
        explain: sinon.spy((verbosity): any => ({ ok: verbosity }))
      };
      wrappee._cursor = wrappee;
      eCursor = new ExplainableCursor({} as any, wrappee as any, 'queryPlannerExtended');
    });

    it('sets dynamic properties', async() => {
      expect((await toShellResult(eCursor)).type).to.equal('ExplainableCursor');
      expect((await toShellResult(eCursor.help)).type).to.equal('Help');
      expect((await toShellResult(eCursor)).printable).to.deep.equal({ ok: 'queryPlannerExtended' });
      expect(eCursor._verbosity).to.equal('queryPlannerExtended');
      expect(wrappee.explain).to.have.callCount(1);
    });

    it('returns the same ExplainableCursor', () => {
      expect(eCursor.map()).to.equal(eCursor);
    });

    it('has the correct metadata', () => {
      expect(eCursor.collation.serverVersions).to.deep.equal(['3.4.0', ServerVersions.latest]);
    });
  });
});
