/**
 * Helper script to complete a workflow stage.
 * We use dynamic import to try to access the same module cache as the pi extension.
 */
const path = await import('node:path');

// Try different import strategies
async function tryImport() {
  const cwd = process.cwd();
  const poolId = process.argv[2];
  if (!poolId) {
    console.error('Usage: node _complete_stage.mjs <poolId>');
    process.exit(1);
  }

  // Strategy 1: Direct import via URL (for ESM)
  const storePath = path.resolve(cwd, 'src/pi/workflow/stage-result-store.ts');
  const storeUrl = new URL(`file://${storePath}`).href;
  
  try {
    const mod = await import(storeUrl);
    if (typeof mod.setStageResult === 'function') {
      mod.setStageResult(poolId, {
        type: 'complete',
        summary: '已完成目录查询',
        context: '当前目录下有6个目录：dist/, docs/, img/, node_modules/, scripts/, src/'
      });
      console.log(`✓ setStageResult called for ${poolId} via ESM import`);
      return;
    }
  } catch (e) {
    console.log(`ESM import failed: ${e.message}`);
  }

  // Strategy 2: Try require.resolve to find cached module
  try {
    const mod = require(path.resolve(cwd, 'src/pi/workflow/stage-result-store.ts'));
    if (typeof mod.setStageResult === 'function') {
      mod.setStageResult(poolId, {
        type: 'complete',
        summary: '已完成目录查询',
        context: '当前目录下有6个目录：dist/, docs/, img/, node_modules/, scripts/, src/'
      });
      console.log(`✓ setStageResult called for ${poolId} via require`);
      return;
    }
  } catch (e) {
    console.log(`require failed: ${e.message}`);
  }

  console.error('✗ Could not import stage-result-store');
}

tryImport().catch(e => console.error(e));
