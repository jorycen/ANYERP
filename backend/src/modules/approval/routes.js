const Router = require('koa-router');
const { requireRole } = require('../../middleware/permission');
const controller = require('./controller');

const router = new Router();

router.get('/flows', controller.listFlows);
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
