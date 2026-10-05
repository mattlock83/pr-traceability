import { escapeAnnotation, run } from './action.mjs';

try {
  await run();
} catch (error) {
  console.log(`::error::${escapeAnnotation(error.message)}`);
  process.exitCode = 1;
}
