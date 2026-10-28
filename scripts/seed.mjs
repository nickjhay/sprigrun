import { shareSource } from '../vendor/blob-store/examples/client.ts';
import { demoSources } from '../src/examples.ts';
import { storeOrigin } from '../src/document.ts';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
export async function seed(origin) {
  const demo = await demoSources();
  await shareSource(origin,demo.library);
  await shareSource(origin,demo.program);
  await shareSource(origin,demo.fernLibrary);
  await shareSource(origin,demo.fernProgram);
  return demo;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('Specify the store origin. This command publishes the four Moss demo sources to that store.');
  const demo = await seed(storeOrigin(process.argv[2]));
  console.log('Published library: '+demo.libraryAddress+'\nPublished postcard: '+demo.programAddress+'\nPublished fronds: '+demo.fernLibraryAddress+'\nPublished fern: '+demo.fernProgramAddress);
}
