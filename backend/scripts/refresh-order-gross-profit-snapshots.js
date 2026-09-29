const { sequelize } = require('../src/models');
const { refreshOutdatedGrossProfitSnapshots, FORMULA_VERSION } = require('../src/modules/sales/grossProfit');

(async () => {
  console.log('[GrossProfit] loading outdated and missing snapshots...');
  const result = await refreshOutdatedGrossProfitSnapshots({
    onProgress(progress) {
      if (progress.phase === 'refreshing' && progress.total !== undefined) {
        console.log(`[GrossProfit] refreshed ${progress.refreshed}/${progress.total}, failed ${progress.failed}`);
      } else if (progress.phase === 'failed') {
        console.error(`[GrossProfit] failed order ${progress.orderId}: ${progress.message}`);
      } else {
        console.log(`[GrossProfit] ${progress.phase}...`);
      }
    }
  });
  console.log(JSON.stringify({ formulaVersion: FORMULA_VERSION, ...result }));
  await sequelize.close();
})().catch(async error => {
  console.error(error.message);
  await sequelize.close();
  process.exitCode = 1;
});
