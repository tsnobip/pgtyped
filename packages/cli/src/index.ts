#!/usr/bin/env node

import { startup } from 'pgtyped-rescript-query';
import { AsyncQueue } from '@pgtyped/wire';
import chokidar from 'chokidar';
import { globSync } from 'glob';
import nun from 'nunjucks';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import { debug } from './util.js';
import { parseConfig, ParsedConfig, TransformConfig } from './config.js';
import path from 'path';

import WorkerPool from 'piscina';

// tslint:disable:no-console

nun.configure({ autoescape: false });

interface TransformJob {
  files: string[];
  transform: TransformConfig;
}

class FileProcessor {
  private readonly pool: WorkerPool;
  public readonly workQueue: Promise<unknown>[] = [];

  constructor(private readonly config: ParsedConfig) {
    this.pool = new WorkerPool({
      filename: new URL('./worker.js', import.meta.url).href,
      workerData: config,
    });
    console.log(`Using a pool of ${this.pool.threads.length} threads.`);
  }

  public async shutdown() {
    await this.pool.destroy();
  }

  public push(job: TransformJob) {
    this.workQueue.push(
      ...job.files.map(async (fileName) => {
        try {
          fileName = path.relative(process.cwd(), fileName);
          console.log(`Processing ${fileName}`);
          const result = await this.pool.run({
            fileName,
            transform: job.transform,
          });
          if (result.skipped) {
            console.log(
              `Skipped ${fileName}: no changes or no queries detected`,
            );
          } else {
            console.log(
              `Saved ${result.typeDecsLength} query types from ${fileName} to ${result.relativePath}`,
            );
          }
        } catch (err) {
          if (err instanceof Error) {
            const isWorkerTermination =
              err.message === 'Terminating worker thread';
            if (isWorkerTermination) {
              return;
            }

            console.log(
              `Error processing file: ${err.stack || JSON.stringify(err)}`,
            );
          } else {
            console.log(`Error processing file: ${JSON.stringify(err)}`);
          }
          if (this.config.failOnError) {
            await this.pool.destroy();
            process.exit(1);
          }
        }
      }),
    );
  }
}

async function main(
  cfg: ParsedConfig | Promise<ParsedConfig>,
  // tslint:disable-next-line:no-shadowed-variable
  isWatchMode: boolean,
  // tslint:disable-next-line:no-shadowed-variable
  fileOverride?: string,
) {
  const config = await cfg;
  const connection = new AsyncQueue();
  debug('starting codegenerator');
  await startup(config.db, connection);

  debug('connected to database %o', config.db.dbName);

  const fileProcessor = new FileProcessor(config);
  let fileOverrideUsed = false;
  for (const transform of config.transforms) {
    const pattern = `${config.srcDir}/**/${transform.include}`;
    if (isWatchMode) {
      const cb = (filePath: string) => {
        fileProcessor.push({
          files: [filePath],
          transform,
        });
      };
      chokidar
        .watch(pattern, { persistent: true })
        .on('add', cb)
        .on('change', cb);
    } else {
      /**
       * If the user didn't provide the -f paramter, we're using the list of files we got from glob.
       * If he did, we're using glob file list to detect if his provided file should be used with this transform.
       */
      let fileList = globSync(pattern);
      if (fileOverride) {
        fileList = fileList.includes(fileOverride) ? [fileOverride] : [];
        if (fileList.length > 0) {
          fileOverrideUsed = true;
        }
      }
      debug('found query files %o', fileList);
      const transformJob = {
        files: fileList,
        transform,
      };
      fileProcessor.push(transformJob);
    }
  }
  if (fileOverride && !fileOverrideUsed) {
    console.log(
      'File override specified, but file was not found in provided transforms',
    );
  }
  if (!isWatchMode) {
    await Promise.all(fileProcessor.workQueue);
    await fileProcessor.shutdown();
    process.exit(0);
  }
}

const args = yargs(hideBin(process.argv))
  .version()
  .env()
  .options({
    config: {
      alias: 'c',
      type: 'string',
      description: 'Config file path',
      demandOption: true,
    },
    watch: {
      alias: 'w',
      description: 'Watch mode',
      type: 'boolean',
    },
    uri: {
      type: 'string',
      description: 'DB connection URI (overrides config)',
    },
    file: {
      alias: 'f',
      type: 'string',
      conflicts: 'watch',
      description: 'File path (process single file, incompatible with --watch)',
    },
  })
  .epilogue('For more information, find our manual at https://pgtyped.dev/')
  .parseSync();

const {
  watch: isWatchMode,
  file: fileOverride,
  config: configPath,
  uri: connectionUri,
} = args;

if (typeof configPath !== 'string') {
  console.log('Config file required. See help -h for details.\nExiting.');
  process.exit(0);
}

if (isWatchMode && fileOverride) {
  console.log('File override is not compatible with watch mode.\nExiting.');
  process.exit(0);
}

try {
  chokidar.watch(configPath).on('change', () => {
    console.log('Config file changed. Exiting.');
    process.exit();
  });
  const config = parseConfig(configPath, connectionUri);
  main(config, isWatchMode || false, fileOverride).catch((e) =>
    debug('error in main: %o', e.message),
  );
} catch (e) {
  console.error('Failed to parse config file:');
  console.error((e as any).message);
  process.exit();
}
