/* eslint-disable chai-friendly/no-unused-expressions */
import { Domain } from 'domain';
import type { EventEmitter } from 'events';
import isRecoverableError from 'is-recoverable-error';
import { Interface, ReadLineOptions } from 'readline';
import type { ReplOptions, REPLServer } from 'repl';
import { Recoverable, start as originalStart } from 'repl';
import { promisify } from 'util';

// Utility, inverse of Readonly<T>
type Mutable<T> = {
  -readonly[P in keyof T]: T[P]
};

export type OriginalEvalFunction = (input: string, context: any, filename: string) => Promise<any>;
export type AsyncEvalFunction = (originalEval: OriginalEvalFunction, input: string, context: any, filename: string) => Promise<any>;

export type AsyncREPLOptions = ReadLineOptions & Omit<ReplOptions, 'eval' | 'breakEvalOnSigint'> & {
  start?: typeof originalStart,
  wrapCallbackError?: (err: Error) => Error;
  asyncEval: AsyncEvalFunction;
  onAsyncSigint?: () => Promise<boolean> | boolean;
};

export type EvalStartEvent = {
  input: string;
};
export type EvalFinishEvent = EvalStartEvent & ({
  success: true;
} | {
  success: false;
  err: unknown;
  recoverable: boolean;
});

export const evalStart = Symbol('async-repl:evalStart');
export const evalFinish = Symbol('async-repl:evalFinish');

// Helper for temporarily disabling an event on an EventEmitter.
type RestoreEvents = { restore: () => void };
function disableEvent(emitter: EventEmitter, event: string): RestoreEvents {
  const rawListeners = emitter.rawListeners(event);
  emitter.removeAllListeners(event);
  return {
    restore() {
      for (const listener of rawListeners) {
        emitter.on(event, listener as any);
      }
    }
  };
}

function getPrompt(repl: any): string {
  // Use public getPrompt() API once available (Node.js 15+)
  return repl.getPrompt?.() ?? repl._prompt;
}

/**
 * Start a REPLServer that supports asynchronous evaluation, rather than just
 * synchronous, and integrates nicely with Ctrl+C handling in that respect.
 */
export function start(opts: AsyncREPLOptions): REPLServer {
  const {
    asyncEval,
    wrapCallbackError = err => err,
    onAsyncSigint
  } = opts;
  if (onAsyncSigint) {
    (opts as ReplOptions).breakEvalOnSigint = true;
  }

  const repl = (opts.start ?? originalStart)(opts);
  const originalEval = promisify(wrapNoSyncDomainError(repl.eval.bind(repl)));

  (repl as Mutable<typeof repl>).eval = async(
    input: string,
    context: any,
    filename: string,
    callback: (err: Error|null, result?: any) => void): Promise<void> => {
    let result;
    repl.emit(evalStart, { input } as EvalStartEvent);

    // Use public getPrompt() API once available (Node.js 15+)
    const origPrompt = getPrompt(repl);
    // Disable printing prompts while we're evaluating code. We're using the
    // readline superclass method instead of the REPL one here, because the REPL
    // one stores the prompt to later be reset in case of dropping into .editor
    // mode. In particular, the following sequence of results is what we want
    // to avoid:
    // 1. .editor entered
    // 2. Some code entered
    // 3. Tab used for autocompletion, leading to this evaluation being called
    //    while the REPL prompt is still turned off due to .editor
    // 4. Evaluation ends, we use .setPrompt() to restore the prompt that has
    //    temporarily been disable for .editor
    // 5. The REPL thinks that the empty string is supposed to be the prompt
    //    even after .editor is done.
    Interface.prototype.setPrompt.call(repl, '');

    try {
      let exitEventPending = false;
      const exitListener = () => { exitEventPending = true; };
      let previousExitListeners: any[] = [];

      let sigintListener: (() => void) | undefined = undefined;
      let replSigint: RestoreEvents | undefined = undefined;
      let processSigint: RestoreEvents | undefined = undefined;

      try {
        result = await new Promise((resolve, reject) => {
          if (onAsyncSigint) {
            // Handle SIGINT (Ctrl+C) that occurs while we are stuck in `await`
            // by racing a listener for 'SIGINT' against the evalResult Promise.
            // We remove all 'SIGINT' listeners and install our own.
            sigintListener = async(): Promise<void> => {
              let interruptHandled = false;
              try {
                interruptHandled = await onAsyncSigint();
              } catch (e) {
                // ignore
              } finally {
                // Reject with an exception similar to one thrown by Node.js
                // itself if the `customEval` itself is interrupted
                // and the asyncSigint handler did not deal with it
                reject(interruptHandled ? undefined : new Error('Asynchronous execution was interrupted by `SIGINT`'));
              }
            };

            replSigint = disableEvent(repl, 'SIGINT');
            processSigint = disableEvent(process, 'SIGINT');

            repl.once('SIGINT', sigintListener);
          }

          // The REPL may become over-eager and emit 'exit' events while our
          // evaluation is still in progress (because it doesn't expect async
          // evaluation). If that happens, defer the event until later.
          previousExitListeners = repl.rawListeners('exit');
          repl.removeAllListeners('exit');
          repl.once('exit', exitListener);

          const evalResult = asyncEval(originalEval, input, context, filename);

          if (sigintListener !== undefined) {
            process.once('SIGINT', sigintListener);
          }
          evalResult.then(resolve, reject);
        });
      } finally {
        // Remove our 'SIGINT' listener and re-install the REPL one(s).
        if (sigintListener !== undefined) {
          repl.removeListener('SIGINT', sigintListener);
          process.removeListener('SIGINT', sigintListener);
        }
        // See https://github.com/microsoft/TypeScript/issues/43287 for context on
        // why `as any` is needed.
        (replSigint as any)?.restore?.();
        (processSigint as any)?.restore?.();

        if (getPrompt(repl) === '') {
          Interface.prototype.setPrompt.call(repl, origPrompt);
        }

        repl.removeListener('exit', exitListener);
        for (const listener of previousExitListeners) {
          repl.on('exit', listener);
        }
        if (exitEventPending) {
          process.nextTick(() => repl.emit('exit'));
        }
      }
    } catch (err) {
      try {
        if (isRecoverableError(input)) {
          repl.emit(evalFinish, { input, success: false, err, recoverable: true } as EvalFinishEvent);
          return callback(new Recoverable(err));
        }
        repl.emit(evalFinish, { input, success: false, err, recoverable: false } as EvalFinishEvent);
        return callback(err);
      } catch (callbackErr) {
        return callback(wrapCallbackError(callbackErr));
      }
    }
    try {
      repl.emit(evalFinish, { input, success: true } as EvalFinishEvent);
      return callback(null, result);
    } catch (callbackErr) {
      return callback(wrapCallbackError(callbackErr));
    }
  };

  return repl;
}

function wrapNoSyncDomainError<Args extends any[], Ret>(fn: (...args: Args) => Ret) {
  return (...args: Args): Ret => {
    const origEmit = Domain.prototype.emit;

    // When the Node.js core REPL encounters an exception during synchronous
    // evaluation, it does not pass the exception value to the callback
    // (or in this case, reject the Promise here), as one might inspect.
    // Instead, it skips straight ahead to abandoning evaluation and acts
    // as if the error had been thrown asynchronously. This works for them,
    // but for us that's not great, because we rely on the core eval function
    // calling its callback in order to be informed about a possible error
    // that occurred (... and in order for this async function to finish at all.)
    // We monkey-patch `process.domain.emit()` to avoid that, and instead
    // handle a possible error ourselves:
    // https://github.com/nodejs/node/blob/59ca56eddefc78bab87d7e8e074b3af843ab1bc3/lib/repl.js#L488-L493
    // It's not clear why this is done this way in Node.js, however,
    // removing the linked code does lead to failures in the Node.js test
    // suite, so somebody sufficiently motivated could probably find out.
    // For now, this is a hack and probably not considered officially
    // supported, but it works.
    // We *may* want to consider not relying on the built-in eval function
    // at all at some point.
    Domain.prototype.emit = function(ev: string, ...eventArgs: any[]): boolean {
      if (ev === 'error') {
        this.exit();
        throw eventArgs[0];
      }
      return origEmit.call(this, ev, ...eventArgs);
    };

    try {
      return fn(...args);
    } finally {
      // Reset the `emit` function after synchronous evaluation, because
      // we need the Domain functionality for the asynchronous bits.
      Domain.prototype.emit = origEmit;
    }
  };
}

