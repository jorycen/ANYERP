const Router = require('koa-router');
const { resolveCloudFileUrls } = require('./controller');

const router = new Router();

router.post('/file-urls', resolveCloudFileUrls);

module.exports = router;
