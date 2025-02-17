import { CliRepl, parseCliArgs, mapCliToDriver, getStoragePaths, getMongocryptdPaths, runSmokeTests, USAGE, buildInfo } from './index';
import { generateUri } from '@mongosh/service-provider-server';
import { redactURICredentials } from '@mongosh/history';
import { runMain } from 'module';
import readline from 'readline';
import askcharacter from 'askcharacter';
import stream from 'stream';
import { createServer, IncomingMessage, ServerResponse } from 'http';

async function evalInternal(reqBodyStr: string): Promise<string> {
  const reqBody = JSON.parse(reqBodyStr);
  if (process.env.MONGOSH_RUN_NODE_SCRIPT) {
    // For uncompiled mongosh: node /path/to/this/file script ... -> node script ...
    // FOr compiled mongosh: mongosh mongosh script ... -> mongosh script ...
    process.argv.splice(1, 1);
    (runMain as any)(process.argv[1]);
    return '';
  }

  let repl;
  let isSingleConsoleProcess = false;
  try {
    const options = parseCliArgs(process.argv);

    for (const warning of options._argParseWarnings) {
      console.warn(warning);
    }

    const { version } = require('../package.json');

    if (options.help) {
      // eslint-disable-next-line no-console
      console.log(USAGE);
    } else if (options.version) {
      // eslint-disable-next-line no-console
      console.log(version);
    } else if (options.buildInfo) {
      // eslint-disable-next-line no-console
      console.log(JSON.stringify(buildInfo(), null, '  '));
    } else if (options.smokeTests) {
      const smokeTestServer = process.env.MONGOSH_SMOKE_TEST_SERVER;
      if (process.execPath === process.argv[1]) {
        // This is the compiled binary. Use only the path to it.
        await runSmokeTests(smokeTestServer, process.execPath);
      } else {
        // This is not the compiled binary. Use node + this script.
        await runSmokeTests(smokeTestServer, process.execPath, process.argv[1]);
      }
    } else {
      let mongocryptdSpawnPaths = [['mongocryptd']];
      if (process.execPath === process.argv[1]) {
        // Remove the built-in Node.js listener that prints e.g. deprecation
        // warnings in single-binary release mode.
        process.removeAllListeners('warning');
        // Look for mongocryptd in the locations where our packaging would
        // have put it.
        mongocryptdSpawnPaths = await getMongocryptdPaths();
      }

      // This is for testing under coverage, see the the comment in the tests
      if (process.env.CLEAR_SIGINT_LISTENERS) {
        process.removeAllListeners('SIGINT');
      }

      // If we are spawned via Windows doubleclick, ask the user for an URI to
      // connect to. Allow an environment variable to override this for testing.
      isSingleConsoleProcess = !!process.env.MONGOSH_FORCE_CONNECTION_STRING_PROMPT;
      if ((!options.connectionSpecifier &&
        process.platform === 'win32' &&
        process.stdin.isTTY &&
        process.stdout.isTTY) ||
        isSingleConsoleProcess) {
        try {
          isSingleConsoleProcess ||= require('get-console-process-list')().length === 1;
        } catch { /* ignore */ }
        if (isSingleConsoleProcess) {
          const result = await ask('Please enter a MongoDB connection string (Default: mongodb://localhost/): ');
          if (result.trim() !== '') {
            options.connectionSpecifier = result.trim();
          }
        }
      }

      const driverOptions = mapCliToDriver(options);
      const driverUri = generateUri(options);

      const title = `mongosh ${redactURICredentials(driverUri)}`;
      process.title = title;
      setTerminalWindowTitle(title);

      const appName = `mongosh ${version}`;
      const shellHomePaths = getStoragePaths();
      let funs = '(function(obj) { if((typeof obj.toArray) ==="undefined"){ print(JSON.stringify(obj)); } else { print(JSON.stringify(obj.toArray())); } })(';
      funs += reqBody.funs;
      funs += ') ';
      repl = new CliRepl({
        shellCliOptions: {
          ...options,
          'quiet': true,
          'eval': funs,
          'norc': true,
        },
        mongocryptdSpawnPaths,
        input: process.stdin,
        output: process.stdout,
        onExit: process.exit,
        shellHomePaths: shellHomePaths
      });
      await repl.start(reqBody.connect_string, { appName, ...driverOptions });
      return repl.mongoshRepl.prettyTextResult;
    }
  } catch (e) {
    console.error(`${e.name}: ${e.message}`);
    if (repl !== undefined) {
      repl.bus.emit('mongosh:error', e, 'startup');
    }
    if (isSingleConsoleProcess) {
      // In single-process-console mode, it's confusing for the window to be
      // closed immediately after receiving an error. In that case, ask the
      // user to explicitly close the window.
      process.stdout.write('Press any key to exit: ');
      await askcharacter({ input: process.stdin, output: process.stdout });
      process.stdout.write('\n');
    }
    // process.exit(1);
  }
  return '';
}







interface Post {
  title: string;
  content: string;
};

const posts: Post[] = [
  {
    title: 'Lorem ipsum',
    content: 'Dolor sit amet'
  }
];

const server = createServer((request, response) => {
  if (request.method === 'POST' && request.url === '/mongodb_shell') {
    let data = '';
    request.on('data', (chunk) => {
      data += chunk;
    }).on('end', () => {
      const cmd_response = evalInternal(data);
      cmd_response.then((mongodbResText) => {
        response.setHeader('Content-Type', 'application/json');
        response.end(mongodbResText);
      });
    });
  } else {
    response.statusCode = 404;
    response.end();
  }
});

server.on('error', (e) => {
  console.log(e);
});
server.listen(51234, () => {
  console.log(`Server listening on port 51234`);
});





/**
 * Helper to set the window title for the terminal that stdout is
 * connected to, if any.
 *
 * @param title The terminal window title
 */
function setTerminalWindowTitle(title: string): void {
  if (!process.stdout.isTTY) {
    return;
  }

  // see: https://that.guru/blog/automatically-set-tmux-window-name/
  const term = process.env.TERM ?? '';
  if (/^(linux|xterm|rxvt)/.test(term)) {
    process.stdout.write(`\u001b]0;${title}\u0007`);
  } else if (/^screen/.test(term)) {
    process.stdout.write(`\u001bk${title}\u001b\\`);
  }
}

/**
 * Helper to wait for single-line input. Note that this only works until
 * the actual mongosh REPL instance is created and attached to process.stdin.
 *
 * @param prompt The prompt to ask for
 * @returns The written user input
 */
async function ask(prompt: string): Promise<string> {
  // Copy stdin to a second stream so that we can still attach it
  // to the main mongosh REPL instance later without conflicts.
  const stdinCopy = process.stdin.pipe(new stream.PassThrough());
  try {
    const readlineInterface = readline.createInterface({
      input: stdinCopy,
      output: process.stdout,
      prompt,
    });
    readlineInterface.prompt();
    // for-await automatically reads input lines + closes the readline instance again
    for await (const line of readlineInterface) {
      return line;
    }
    return ''; // Unreachable
  } finally {
    process.stdin.unpipe(stdinCopy);
  }
}
