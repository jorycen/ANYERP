const Router = require('koa-router');
const multer = require('@koa/multer');
const { upload, resolveCloudFileUrls } = require('./controller');

const router = new Router();
const uploadMiddleware = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: 1 }
});

router.post('/upload', uploadMiddleware.single('file'), upload);
router.post('/file-urls', resolveCloudFileUrls);

module.exports = router;
