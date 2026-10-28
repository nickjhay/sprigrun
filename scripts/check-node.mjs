// Keep this check in plain JavaScript so unsupported Node versions can explain
// the problem before the dev launcher imports any TypeScript or dependencies.
if (Number(process.versions.node.split('.')[0]) < 24) {
  console.error(`Sprig workbench requires Node.js 24 or newer; you are running ${process.version}.
The local tools use Node's built-in TypeScript support.

From the project directory, if you use nvm:
  nvm install
  nvm use
  npm ci
  npm run dev

Otherwise install Node.js 24, reopen your terminal, and run npm ci again.`);
  process.exit(1);
}
