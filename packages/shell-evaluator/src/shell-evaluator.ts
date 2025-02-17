import {
  ShellInstanceState,
  toShellResult,
  ShellResult,
  EvaluationListener
} from '@mongosh/shell-api';
import AsyncWriter from '@mongosh/async-rewriter2';

type EvaluationFunction = (input: string, context: object, filename: string) => Promise<any>;

import { HIDDEN_COMMANDS, redactSensitiveData } from '@mongosh/history';

type ResultHandler<EvaluationResultType> = (value: any) => EvaluationResultType | Promise<EvaluationResultType>;
class ShellEvaluator<EvaluationResultType = ShellResult> {
  private instanceState: ShellInstanceState;
  private resultHandler: ResultHandler<EvaluationResultType>;
  private hasAppliedAsyncWriterRuntimeSupport = true;
  private asyncWriter: AsyncWriter;

  constructor(instanceState: ShellInstanceState, resultHandler: ResultHandler<EvaluationResultType> = toShellResult as any) {
    this.instanceState = instanceState;
    this.resultHandler = resultHandler;
    this.asyncWriter = new AsyncWriter();
    this.hasAppliedAsyncWriterRuntimeSupport = false;
  }

  /**
   * Checks for linux-style commands then evaluates input using originalEval.
   *
   * @param {function} originalEval - the javascript evaluator.
   * @param {String} input - user input.
   * @param {Context} context - the execution context.
   * @param {String} filename
   */
  private async innerEval(originalEval: EvaluationFunction, input: string, context: object, filename: string): Promise<any> {
    const { shellApi } = this.instanceState;
    const argv = input.trim().replace(/;$/, '').split(/\s+/g);
    const cmd = argv.shift() as keyof typeof shellApi;
    if (shellApi[cmd]?.isDirectShellCommand && !(argv[0] ?? '').startsWith('(')) {
      return shellApi[cmd](...argv);
    }

    let rewrittenInput = this.asyncWriter.process(input);

    const hiddenCommands = RegExp(HIDDEN_COMMANDS, 'g');
    if (!hiddenCommands.test(input) && !hiddenCommands.test(rewrittenInput)) {
      this.instanceState.messageBus.emit(
        'mongosh:evaluate-input',
        { input: redactSensitiveData(input.trim()) }
      );
    }

    if (!this.hasAppliedAsyncWriterRuntimeSupport) {
      this.hasAppliedAsyncWriterRuntimeSupport = true;
      const supportCode = this.asyncWriter.runtimeSupportCode();
      // Eval twice: We need the modified prototypes to be present in both
      // the evaluation context and the current one, because e.g. the value of
      // db.test.find().toArray() is a Promise for an Array from the context
      // in which the shell-api package lives and not from the context inside
      // the REPL (i.e. `db.test.find().toArray() instanceof Array` is `false`).
      // eslint-disable-next-line no-eval
      eval(supportCode);
      rewrittenInput = supportCode + ';\n' + rewrittenInput;
    }

    try {
      return await originalEval(rewrittenInput, context, filename);
    } catch (err) {
      throw this.instanceState.transformError(err);
    }
  }

  /**
   * Evaluates the input code and wraps the result with the type
   *
   * @param {function} originalEval - the javascript evaluator.
   * @param {String} input - user input.
   * @param {Context} context - the execution context.
   * @param {String} filename
   */
  public async customEval(originalEval: EvaluationFunction, input: string, context: object, filename: string): Promise<EvaluationResultType> {
    const evaluationResult = await this.innerEval(
      originalEval,
      input,
      context,
      filename
    );

    return await this.resultHandler(evaluationResult);
  }
}

export {
  ShellResult,
  ShellEvaluator,
  EvaluationListener
};
