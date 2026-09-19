const Router = require('koa-router');
const { requireRole } = require('../../middleware/permission');
const controller = require('./controller');

const router = new Router();

router.get('/flows', controller.listFlows);
router.post('/initialize', requireRole('admin', 'boss'), async ctx => {
  await require('./catalog').seedApprovalFlowCatalog();
  ctx.body = { code: 0, message: '已补齐缺失流程，现有配置保持不变' };
});
router.get('/business-tasks', async ctx => require('./businessRuntime').listBusinessTasks(ctx));
router.post('/business/:businessType/:businessId/action', async ctx => {
  await require('./businessRuntime').dispatch(ctx, ctx.params.businessType, ctx.params.businessId, ctx.request.body?.action, ctx.request.body?.comment || '');
});
router.get('/flows/:definitionId', controller.getFlow);
router.post('/flows', requireRole('admin', 'boss'), controller.createFlow);
router.put('/flows/:definitionId', requireRole('admin', 'boss'), controller.updateFlow);
router.post('/flows/:definitionId/publish', requireRole('admin', 'boss'), controller.publishFlow);
router.post('/flows/:definitionId/disable', requireRole('admin', 'boss'), controller.disableFlow);
router.get('/assignee-options', requireRole('admin', 'boss'), controller.getAssigneeOptions);

router.get('/tasks', controller.listTasks);
router.get('/instances', controller.listInstances);
router.get('/instances/:instanceId', controller.getInstance);
router.post('/instances', controller.submitInstance);
router.post('/instances/:instanceId/action', controller.action);
router.post('/instances/:instanceId/resubmit', controller.resubmit);

module.exports = router;
