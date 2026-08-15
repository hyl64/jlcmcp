const fs = require('fs');
const path = require('path');
const archiver = require('archiver');

const projectDir = path.join(__dirname, '..');
const compiledEntry = path.join(projectDir, 'dist', 'index.js');
const extensionJsonPath = path.join(projectDir, 'extension.json');
const packageRoot = path.join(projectDir, 'build', 'package');
const packageDist = path.join(packageRoot, 'dist');
const zipPath = path.join(projectDir, 'build', 'package.zip');

function resetDir(dir) {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.mkdirSync(dir, { recursive: true });
}

function removeIfExists(filePath) {
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

function writeUtf8NoBom(filePath, text) {
  fs.writeFileSync(filePath, text, { encoding: 'utf8' });
}

function createZip(outputPath, entries) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outputPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', resolve);
    output.on('error', reject);
    archive.on('error', reject);
    archive.pipe(output);

    for (const entry of entries) {
      archive.file(entry.source, { name: entry.name });
    }

    archive.finalize();
  });
}

async function main() {
  console.log('packing jlc-bridge...');

  if (!fs.existsSync(compiledEntry)) {
    throw new Error(`compiled entry not found: ${compiledEntry}`);
  }

  const extensionConfig = JSON.parse(fs.readFileSync(extensionJsonPath, 'utf8'));
  const extensionName = String(extensionConfig.name || 'jlc-bridge');
  const extensionVersion = String(extensionConfig.version || '0.0.0');

  const versionedEextPath = path.join(projectDir, 'build', `${extensionName}_v${extensionVersion}.eext`);
  const latestEextPath = path.join(projectDir, 'build', `${extensionName}.eext`);
  const latestLcexPath = path.join(projectDir, 'build', `${extensionName}.lcex`);

  resetDir(packageRoot);
  fs.mkdirSync(packageDist, { recursive: true });

  // Keep both root and dist entries for compatibility with different loaders.
  fs.copyFileSync(compiledEntry, path.join(packageRoot, 'index.js'));
  fs.copyFileSync(compiledEntry, path.join(packageRoot, 'index'));
  fs.copyFileSync(compiledEntry, path.join(packageDist, 'index.js'));
  fs.copyFileSync(compiledEntry, path.join(packageDist, 'index'));

  // Re-serialize extension.json to guarantee UTF-8 without BOM.
  const extensionJsonNoBom = JSON.stringify(extensionConfig, null, 2);
  writeUtf8NoBom(path.join(packageRoot, 'extension.json'), extensionJsonNoBom);

  removeIfExists(zipPath);
  removeIfExists(versionedEextPath);
  removeIfExists(latestEextPath);
  removeIfExists(latestLcexPath);

  await createZip(zipPath, [
    { source: path.join(packageRoot, 'extension.json'), name: 'extension.json' },
    { source: path.join(packageRoot, 'index.js'), name: 'index.js' },
    { source: path.join(packageRoot, 'index'), name: 'index' },
    { source: path.join(packageDist, 'index.js'), name: 'dist/index.js' },
    { source: path.join(packageDist, 'index'), name: 'dist/index' },
  ]);

  fs.copyFileSync(zipPath, versionedEextPath);
  fs.copyFileSync(zipPath, latestEextPath);
  fs.copyFileSync(zipPath, latestLcexPath);
  fs.unlinkSync(zipPath);

  const sizeKb = (fs.statSync(versionedEextPath).size / 1024).toFixed(1);
  console.log(`done: ${versionedEextPath} (${sizeKb} KB)`);
  console.log(`done: ${latestEextPath}`);
  console.log(`done: ${latestLcexPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
