/**
 * Copies the Prisma client generated during the workspace build into a
 * `pnpm deploy` bundle. pnpm keeps the generated `.prisma/client` next to the
 * `@prisma/client` package it belongs to; the deploy step copies the package but
 * not the generated output.
 *
 *   node copy-prisma-client.cjs <workspace database package dir> <deploy dir>
 */
const fs = require('node:fs');
const path = require('node:path');

const [, , workspacePkg, deployDir] = process.argv;
if (!workspacePkg || !deployDir) {
  console.error('usage: copy-prisma-client.cjs <workspace database package dir> <deploy dir>');
  process.exit(2);
}

const generatedFrom = (pkgDir) => {
  const clientPkg = require.resolve('@prisma/client/package.json', { paths: [fs.realpathSync(pkgDir)] });
  // <...>/node_modules/@prisma/client/package.json → <...>/node_modules/.prisma/client
  return path.join(path.dirname(clientPkg), '..', '..', '.prisma', 'client');
};

const source = generatedFrom(workspacePkg);
if (!fs.existsSync(path.join(source, 'index.js'))) {
  console.error(`No generated Prisma client at ${source} — run "prisma generate" first`);
  process.exit(1);
}
const target = generatedFrom(path.join(deployDir, 'node_modules', '@forgeline', 'database'));
fs.rmSync(target, { recursive: true, force: true });
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.cpSync(source, target, { recursive: true, dereference: true });
console.log(`Prisma client copied → ${path.relative(deployDir, target)}`);
